import { readdir, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { CompletionModel, InlineModel, usableUtilityModels } from '@shared/models'
import { store } from '../store'
import { expandHome } from '../util'
import { runUtilityModel } from './utilityModel'

export interface CompletionRequest {
  path: string
  prefix: string
  suffix: string
}

export interface InlineEditRequest {
  path: string
  before: string
  selection: string
  after: string
  instruction: string
  modelId: string
  requestId: string
}

export async function saveFile(path: string, content: string): Promise<void> {
  await writeFile(expandHome(path), content, 'utf8')
}

/** Drops a fenced code block wrapper, which models add even when told not to. */
function unfence(text: string): string {
  const match = text.match(/^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/)
  return match ? match[1] : text
}

/** In Electron's main process, aborting a fetch can throw from abort() itself; the request still stops. */
function abortQuietly(controller: AbortController | null | undefined): void {
  try {
    controller?.abort()
  } catch {
    // The aborted request rejects on its own side.
  }
}

let pending: AbortController | null = null

export interface Completion {
  text: string
  /** Where the text goes, relative to the cursor. Always 0 with the hole-filler prompt. */
  offset: number
  /** Text in the file, after the insertion, that the cursor should land right after on the next Tab. */
  next: string | null
}

const NONE: Completion = { text: '', offset: 0, next: null }

/*
 * Tab completion follows Continue's autocomplete (github.com/continuedev/continue, core/autocomplete),
 * the approach it uses for chat models that have no fill-in-the-middle endpoint, which is every model
 * on OpenRouter's chat API: a "hole filler" prompt with worked examples, then the same clean-up steps
 * on the answer. Its answer cache is left out: the code around the cursor may have changed since.
 */
const HOLE_FILLER = `You fill holes in code. You get a file with one hole marked {{FILL_HERE}}. Reply with the text that replaces the hole, inside <COMPLETION></COMPLETION>, with indentation that fits where it goes. Do not repeat code that is already before or after the hole. The completion must be correct and fit the surrounding code.

## EXAMPLE QUERY:

<QUERY>
function sumEvens(limit) {
  let sum = 0
  for (let i = 0; i < limit; i++) {
    {{FILL_HERE}}
  }
  return sum
}
</QUERY>

## CORRECT COMPLETION:

<COMPLETION>if (i % 2 === 0) {
      sum += i
    }</COMPLETION>

## EXAMPLE QUERY:

<QUERY>
def total(items):
    result = 0
    for item in items:
    {{FILL_HERE}}
    return result
</QUERY>

## CORRECT COMPLETION:

<COMPLETION>    result += item.price</COMPLETION>

## EXAMPLE QUERY:

<QUERY>
function hypotenuse(a, b) {
  return Math.sqrt({{FILL_HERE}}b ** 2)
}
</QUERY>

## CORRECT COMPLETION:

<COMPLETION>a ** 2 + </COMPLETION>

## EXAMPLE QUERY:

<QUERY>
node_modules
dist
{{FILL_HERE}}
</QUERY>

## CORRECT COMPLETION:

<COMPLETION>.env
.DS_Store</COMPLETION>

If you can tell where the user will edit next after this, you may add <NEXT>…</NEXT> after the completion, holding 10 to 40 characters copied exactly from the file that end right where the cursor should go.`

/** Single-line comments by extension, where a multi-line answer is never wanted. */
function lineComment(path: string): string | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (['py', 'rb', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'r', 'pl'].includes(ext)) return '#'
  if (['sql', 'lua', 'hs'].includes(ext)) return '--'
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'java', 'c', 'h', 'cpp', 'cc', 'cs', 'go', 'rs', 'swift', 'kt', 'php', 'dart', 'scala'].includes(ext)) return '//'
  return null
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = current
    }
  }
  return row[b.length]
}

/** Two lines that are the same apart from a few characters. */
function isRepeat(a: string, b: string): boolean {
  if (a.length <= 4 || b.length <= 4) return false
  return levenshtein(a.trim(), b.trim()) / b.trim().length < 0.1
}

/** Many lines repeating the same pattern, a common way for small models to run on. */
function isExtremeRepetition(lines: string[]): boolean {
  if (lines.length < 6) return false
  for (let step = 1; step < 3; step++) {
    const sample = lines[0].trim()
    if (sample.length < 5 || lines[step]?.trim() !== sample) continue
    const matches = lines.filter((line, index) => index % step === 0 && line.includes(sample)).length
    if (matches * step > 8 || (matches * step) / lines.length > 0.8) return true
  }
  return false
}

const ENGLISH_START = ['here is', "here's", 'the following', 'sure', 'certainly', 'this code', 'to complete']

/** The clean-up steps from Continue's stream filters and postprocessing, applied to a whole answer. */
function postprocess(raw: string, prefix: string, suffix: string, multiline: boolean, model: string): string {
  let text = raw
  const open = text.indexOf('<COMPLETION>')
  if (open !== -1) text = text.slice(open + '<COMPLETION>'.length)
  const close = text.indexOf('</COMPLETION>')
  if (close !== -1) text = text.slice(0, close)
  text = text.replace(/<\/?COMPLETION>/g, '')

  // Code fences around the answer.
  const fenced = text.split('\n')
  if (fenced[0]?.trim().startsWith('```')) fenced.shift()
  if (fenced.length && /^`+$/.test(fenced[fenced.length - 1].trim())) fenced.pop()
  text = fenced.join('\n')

  // Stop where the answer runs into the code after the cursor.
  if (suffix.trimStart().length >= 20) {
    const start = suffix.trimStart().slice(0, 20)
    const at = text.indexOf(start)
    if (at !== -1) text = text.slice(0, at)
  }

  const lineAbove = prefix.split('\n').filter((line) => line.trim()).slice(-1)[0] ?? ''
  const suffixLines = suffix.split('\n')
  const lineBelow = suffixLines.slice(1).find((line) => line.trim()) ?? ''
  const belowIsBracket = /^[\s)\]};,]+$/.test(lineBelow)
  const kept: string[] = []
  let previous: string | undefined
  let repeats = 0
  for (const [index, line] of text.split('\n').entries()) {
    // Chatty openers on the first line.
    if (index === 0 && ENGLISH_START.some((phrase) => line.trim().toLowerCase().startsWith(phrase))) return ''
    // The line below the cursor, written again: stop before it.
    if (index > 0 && lineBelow.trim() && !belowIsBracket && (line === lineBelow || isRepeat(line, lineBelow))) break
    if (line === previous) {
      if (++repeats >= 3) break
    } else repeats = 1
    previous = line
    kept.push(line)
    if (!multiline && index === 0 && line.trim()) break
  }
  // No double blank lines.
  text = kept.join('\n').replace(/\n{3,}/g, '\n\n')

  if (!text.trim()) return ''
  // On a comment line the answer should go on with the comment, not start the code below it.
  if (!multiline && /^(\s{2,}|\t)/.test(text)) return ''
  const lines = text.split('\n')
  const firstLine = lines.find((line) => line.trim()) ?? ''
  if (lineAbove && isRepeat(lineAbove, firstLine)) return ''
  if (isExtremeRepetition(lines)) return ''

  // Model quirks Continue corrects for.
  if (model.includes('codestral')) {
    if (text[0] === ' ' && text[1] !== ' ' && prefix.endsWith(' ') && suffix.startsWith('\n')) text = text.slice(1)
    if (!suffix && prefix.endsWith('\n\n') && text.startsWith('\n')) text = text.slice(1)
  }
  if (model.includes('mercury') && (text.startsWith('  ') || text.startsWith('\t')) && !prefix.endsWith('\n') && (suffix.startsWith('\n') || !suffix.trim())) text = `\n${text}`
  if (prefix.endsWith(' ') && text.startsWith(' ')) text = text.slice(1)

  // A model that copied the start of the current line.
  const lineSoFar = prefix.slice(prefix.lastIndexOf('\n') + 1)
  if (lineSoFar.trim().length >= 2 && text.startsWith(lineSoFar.trimStart()) && !lineSoFar.endsWith(' ')) text = text.slice(lineSoFar.trimStart().length)
  return text.replace(/\s+$/, '')
}

/** Suggests text at the cursor. A newer request cancels the older one. */
export async function completeCode(request: CompletionRequest): Promise<Completion> {
  abortQuietly(pending)
  const controller = new AbortController()
  pending = controller
  const model = usableUtilityModels(CompletionModel, store.settings.accounts).find((m) => m.ID === store.settings.completionModelId) ?? CompletionModel[0]
  if (model.Subscription === 'Default' && !store.openRouterKey) return NONE
  // Whole lines of context, about 6000 characters before and 2000 after.
  const cut = request.prefix.length > 6000 ? request.prefix.indexOf('\n', request.prefix.length - 6000) + 1 : 0
  const prefix = request.prefix.slice(cut)
  const suffix = request.suffix.slice(0, 2000)
  const comment = lineComment(request.path)
  const currentLine = prefix.slice(prefix.lastIndexOf('\n') + 1)
  const multiline = !(comment && currentLine.trimStart().startsWith(comment))
  // Short files like .gitignore say little on their own; the folder's contents help.
  const siblings = await readdir(dirname(expandHome(request.path)), { withFileTypes: true }).catch(() => [])
  const folder = siblings.slice(0, 80).map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).join('\n')
  try {
    const raw = await runUtilityModel(
      model,
      HOLE_FILLER,
      `${folder ? `Files in the same folder:\n${folder}\n\n` : ''}File: ${basename(request.path)}\n\n<QUERY>\n${prefix}{{FILL_HERE}}${suffix}\n</QUERY>\nTASK: Fill the {{FILL_HERE}} hole.${multiline ? '' : ' Keep it to one line.'} Answer only with the completion in <COMPLETION></COMPLETION>, and nothing else.`,
      {
        cwd: dirname(expandHome(request.path)),
        signal: controller.signal,
        // Completions must come back fast, so no thinking.
        openRouterExtra: { reasoning: { effort: 'none', exclude: true }, max_tokens: multiline ? 500 : 120, temperature: 0 }
      }
    )
    const nextMatch = raw.match(/<NEXT>([\s\S]*?)<\/NEXT>/)
    const text = postprocess(raw.replace(/<NEXT>[\s\S]*?(<\/NEXT>|$)/, ''), prefix, suffix, multiline, model.ID)
    if (!text) return NONE
    // Lines the file already has elsewhere, like a second node_modules in .gitignore, are not a completion.
    const lineAfter = suffix.slice(0, suffix.indexOf('\n') === -1 ? suffix.length : suffix.indexOf('\n'))
    const elsewhere = new Set((prefix.slice(0, prefix.length - currentLine.length) + suffix.slice(lineAfter.length)).split('\n').map((line) => line.trim()).filter(Boolean))
    const result = (currentLine + text + lineAfter).split('\n').map((line) => line.trim()).filter(Boolean)
    if (result.length > 0 && result.every((line) => elsewhere.has(line))) return NONE
    return { text, offset: 0, next: nextMatch?.[1] || null }
  } catch (error) {
    if (!controller.signal.aborted) console.warn('[tab completion]', error)
    return NONE
  } finally {
    if (pending === controller) pending = null
  }
}

const running = new Map<string, AbortController>()

export function cancelInlineEdit(requestId: string): void {
  const controller = running.get(requestId)
  running.delete(requestId)
  abortQuietly(controller)
}

/** Rewrites the selection, or writes new lines after the cursor's line. Text streams through onText as it arrives. */
export async function inlineEdit(request: InlineEditRequest, onText: (text: string) => void): Promise<string> {
  const model = usableUtilityModels(InlineModel, store.settings.accounts).find((m) => m.ID === request.modelId) ?? InlineModel[0]
  const target = request.selection
    ? `Rewrite the code between <SELECTION> and </SELECTION>. Reply with only the replacement for it, keeping its indentation.`
    : `Write new code to go on the lines right after the line that ends at <CURSOR>. Reply with only those new lines, indented to fit the surrounding code.`
  const marked = request.selection ? `${request.before}<SELECTION>${request.selection}</SELECTION>${request.after}` : `${request.before}<CURSOR>${request.after}`
  const controller = new AbortController()
  running.set(request.requestId, controller)
  try {
    const result = await runUtilityModel(
      model,
      `You edit code inside an editor. ${target} No explanation and no code fences.`,
      `File: ${basename(request.path)}\n\n${marked.slice(0, 200_000)}\n\nInstruction: ${request.instruction}`,
      {
        cwd: dirname(expandHome(request.path)),
        signal: controller.signal,
        onText(sofar) {
          onText(unfence(sofar.replace(/\n?```\s*$/, '')).replace(/^\s*```[^\n]*\n/, ''))
        }
      }
    )
    return unfence(result)
  } finally {
    running.delete(request.requestId)
  }
}

export interface TerminalCommandRequest {
  instruction: string
  cwd: string
  /** The end of the terminal's output, for context such as an error to fix. */
  output: string
  modelId: string
  requestId: string
}

/** Writes a shell command for the terminal from an instruction. Text streams through onText as it arrives. */
export async function terminalCommand(request: TerminalCommandRequest, onText: (text: string) => void): Promise<string> {
  const model = usableUtilityModels(InlineModel, store.settings.accounts).find((m) => m.ID === request.modelId) ?? InlineModel[0]
  const shell = process.env.SHELL?.split('/').pop() || (process.platform === 'win32' ? 'powershell' : 'sh')
  const controller = new AbortController()
  running.set(request.requestId, controller)
  const clean = (value: string): string => unfence(value.replace(/\n?```\s*$/, '')).replace(/^\s*```[^\n]*\n/, '').replace(/^\$ /, '').trim()
  try {
    const result = await runUtilityModel(
      model,
      `You write shell commands for a ${shell} terminal on ${process.platform}. Reply with only the command, ready to run: no explanation, no code fences, no leading $. Use one line, joining steps with && when needed.`,
      `Working directory: ${request.cwd}\n\nRecent terminal output:\n${request.output.slice(-3000)}\n\nInstruction: ${request.instruction}`,
      { cwd: request.cwd, signal: controller.signal, onText: (sofar) => onText(clean(sofar)) }
    )
    return clean(result)
  } finally {
    running.delete(request.requestId)
  }
}
