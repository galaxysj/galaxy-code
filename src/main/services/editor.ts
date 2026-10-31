import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { CompletionModel, InlineModel, usableUtilityModels } from '@shared/models'
import { store } from '../store'
import { expandHome } from '../util'
import { runUtilityModel } from './utilityModel'

export interface CompletionRequest {
  path: string
  prefix: string
  suffix: string
  /** Snippets from other open files that resemble the code at the cursor. */
  related?: string
  /** The user's latest edits, oldest first, as text. */
  edits?: string
}

export interface EditSuggestionRequest {
  path: string
  /** The whole file, and the cursor's offset in it. */
  text: string
  offset: number
  related?: string
  edits?: string
}

/** Lines startLine to endLine (1-based, inclusive) become `text`. endLine is startLine - 1 when the text is only inserted. */
export interface EditSuggestion {
  startLine: number
  endLine: number
  text: string
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
  const target = expandHome(path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')
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

Always add <NEXT>…</NEXT> after the completion, naming where the user will edit next, holding 10 to 40 characters copied exactly from the file that end right where the cursor should go.`

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

/** Recent suggestions by cursor context, so backspacing and retyping, or returning to a spot, answers at once. */
const completionCache = new Map<string, Completion>()
const CACHE_SIZE = 50

function cacheKey(model: string, request: CompletionRequest): string {
  return `${model}\0${request.path}\0${request.prefix.slice(-1500)}\0${request.suffix.slice(0, 500)}`
}

/** Suggests text at the cursor. A newer request cancels the older one. */
export async function completeCode(request: CompletionRequest): Promise<Completion> {
  const key = cacheKey(store.settings.completionModelId ?? '', request)
  const cached = completionCache.get(key)
  if (cached) return cached
  const result = await completeUncached(request)
  if (result.text) {
    completionCache.set(key, result)
    if (completionCache.size > CACHE_SIZE) completionCache.delete(completionCache.keys().next().value as string)
  }
  return result
}

async function completeUncached(request: CompletionRequest): Promise<Completion> {
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
      `${request.related ? `Related code from other open files, for reference only:\n${request.related.slice(0, 6000)}\n\n` : ''}${request.edits ? `The programmer's latest edits, oldest first. They show what they are working on:\n${request.edits}\n\n` : ''}${folder ? `Files in the same folder:\n${folder}\n\n` : ''}File: ${basename(request.path)}\n\n<QUERY>\n${prefix}{{FILL_HERE}}${suffix}\n</QUERY>\nTASK: Fill the {{FILL_HERE}} hole.${multiline ? '' : ' Keep it to one line.'} Always propose the most likely completion and never leave it empty, even when unsure. Answer only with the completion in <COMPLETION></COMPLETION>, and nothing else.`,
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

const EDIT_BEFORE = 8
const EDIT_AFTER = 24
const MAX_EDIT_LINES = 24

const EDIT_PREDICTOR = `You predict a programmer's next edit. You get a code file with an editable region between <EDITABLE> and </EDITABLE>, the cursor marked <CURSOR>, and the programmer's latest edits. Work out what they are doing, such as renaming something, changing a signature and its calls, or repeating a change on similar lines, and rewrite the editable region as it should look once the next edit is made. Change only lines that the latest edits make necessary. Keep every other line exactly as it is. Always make a prediction: if nothing in the region is left to fix, continue the work with the next thing the programmer would write at the cursor, such as the next statement, the missing case or the missing call. Reply with the whole region inside <REWRITTEN></REWRITTEN> and nothing else. Do not return the region unchanged.`

let pendingEdit: AbortController | null = null

/** What changes between two line lists, once the lines they share at both ends are set aside. */
function changedLines(before: string[], after: string[]): { start: number; oldCount: number; lines: string[] } | null {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--
    endAfter--
  }
  if (start === endBefore && start === endAfter) return null
  return { start, oldCount: endBefore - start, lines: after.slice(start, endAfter) }
}

/** Predicts a change to the lines around the cursor, which can replace several lines at once. A newer request cancels the older one. */
export async function suggestEdit(request: EditSuggestionRequest): Promise<EditSuggestion | null> {
  abortQuietly(pendingEdit)
  const controller = new AbortController()
  pendingEdit = controller
  const model = usableUtilityModels(CompletionModel, store.settings.accounts).find((m) => m.ID === store.settings.completionModelId) ?? CompletionModel[0]
  if (model.Subscription === 'Default' && !store.openRouterKey) return null
  const lines = request.text.split('\n')
  const cursorLine = request.text.slice(0, request.offset).split('\n').length
  const first = Math.max(1, cursorLine - EDIT_BEFORE)
  const last = Math.min(lines.length, cursorLine + EDIT_AFTER)
  const region = lines.slice(first - 1, last)
  const column = request.offset - lines.slice(0, cursorLine - 1).reduce((total, line) => total + line.length + 1, 0)
  const marked = region.map((line, index) => (first + index === cursorLine ? `${line.slice(0, column)}<CURSOR>${line.slice(column)}` : line))
  const above = lines.slice(Math.max(0, first - 1 - 60), first - 1).join('\n')
  const below = lines.slice(last, last + 40).join('\n')
  try {
    const raw = await runUtilityModel(
      model,
      EDIT_PREDICTOR,
      `${request.related ? `Related code from other open files, for reference only:\n${request.related.slice(0, 4000)}\n\n` : ''}File: ${basename(request.path)}\n\n${above ? `${above}\n` : ''}<EDITABLE>\n${marked.join('\n')}\n</EDITABLE>${below ? `\n${below}` : ''}\n\nThe programmer's latest edits, oldest first:\n${request.edits || '(none)'}\n\nReply with the rewritten region in <REWRITTEN></REWRITTEN>.`,
      {
        cwd: dirname(expandHome(request.path)),
        signal: controller.signal,
        openRouterExtra: { reasoning: { effort: 'none', exclude: true }, max_tokens: 1500, temperature: 0 }
      }
    )
    const match = raw.match(/<REWRITTEN>\n?([\s\S]*?)\n?(?:<\/REWRITTEN>|$)/)
    if (!match) return null
    const rewritten = match[1].replace(/<CURSOR>/g, '').split('\n')
    const change = changedLines(region, rewritten)
    if (!change || change.oldCount > MAX_EDIT_LINES || change.lines.length > MAX_EDIT_LINES) return null
    // A change that only adds blank space is not worth showing.
    if (change.lines.join('\n').trim() === region.slice(change.start, change.start + change.oldCount).join('\n').trim()) return null
    return { startLine: first + change.start, endLine: first + change.start + change.oldCount - 1, text: change.lines.join('\n') }
  } catch (error) {
    if (!controller.signal.aborted) console.warn('[edit suggestion]', error)
    return null
  } finally {
    if (pendingEdit === controller) pendingEdit = null
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
