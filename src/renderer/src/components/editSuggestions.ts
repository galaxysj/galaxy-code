import { monaco } from '../lib/monaco'

type Editor = monaco.editor.IStandaloneCodeEditor

const HISTORY_SIZE = 6
const SETTLE_MS = 700
const REQUEST_AGE_MS = 120_000
const SNIPPET_CHARS = 300

interface RecordedEdit {
  at: number
  text: string
}

/** The user's latest edits across every open file, newest last. */
const history: RecordedEdit[] = []

/** Lines that differ between two texts, once the lines they share at both ends are set aside. */
function lineChange(before: string, after: string): { start: number; removed: string[]; added: string[] } | null {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  if (start === endA && start === endB) return null
  return { start, removed: a.slice(start, endA), added: b.slice(start, endB) }
}

const clip = (lines: string[]): string => lines.join('\n').slice(0, SNIPPET_CHARS)

/** The latest edits as text for the model, oldest first. */
export function recentEditsText(): string {
  return history.map((entry) => entry.text).join('\n\n')
}

/**
 * Watches a model and turns each pause in typing into one recorded edit: the lines that changed since the last
 * pause. onSettled runs after each, so the caller can ask for a follow-up edit.
 */
export function trackEdits(model: monaco.editor.ITextModel, onSettled: () => void): monaco.IDisposable {
  let snapshot = model.getValue()
  let timer: ReturnType<typeof setTimeout> | undefined
  const name = model.uri.path.split('/').pop() ?? 'file'
  const watcher = model.onDidChangeContent(() => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      const now = model.getValue()
      const change = lineChange(snapshot, now)
      snapshot = now
      if (!change) return
      const removed = change.removed.length ? `- ${clip(change.removed).replace(/\n/g, '\n- ')}\n` : ''
      const added = change.added.length ? `+ ${clip(change.added).replace(/\n/g, '\n+ ')}` : ''
      history.push({ at: Date.now(), text: `${name}:${change.start + 1}\n${removed}${added}`.trimEnd() })
      if (history.length > HISTORY_SIZE) history.shift()
      onSettled()
    }, SETTLE_MS)
  })
  return {
    dispose() {
      clearTimeout(timer)
      watcher.dispose()
    }
  }
}

export interface EditSuggestion {
  startLine: number
  endLine: number
  text: string
}

/** True while an edit was made recently enough that a prediction still makes sense. */
function hasRecentEdit(): boolean {
  const last = history.at(-1)
  return !!last && Date.now() - last.at < REQUEST_AGE_MS
}

/**
 * A predicted change to several lines, drawn as the old lines in red with the new text in green beneath them.
 * Tab applies it, Esc or typing drops it.
 */
export class EditSuggestionView {
  private decorations: monaco.editor.IEditorDecorationsCollection
  private zone: string | null = null
  private current: EditSuggestion | null = null
  private requestId = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private applying = false
  readonly key: monaco.editor.IContextKey<boolean>
  private readonly content: monaco.IDisposable
  private readonly cursor: monaco.IDisposable

  constructor(private readonly editor: Editor, private readonly model: monaco.editor.ITextModel, private readonly path: string) {
    this.decorations = editor.createDecorationsCollection()
    this.key = editor.createContextKey<boolean>('galaxyEditSuggestion', false)
    this.content = model.onDidChangeContent(() => {
      if (!this.applying) this.clear()
    })
    this.cursor = editor.onDidChangeCursorPosition((event) => {
      if (this.current && event.source !== 'api' && (event.position.lineNumber < this.current.startLine - 1 || event.position.lineNumber > this.current.endLine + 1)) this.clear()
    })
  }

  /** Asks for a prediction once typing settles, unless it is switched off or nothing was edited lately. force skips the recency check. */
  schedule(enabled: () => boolean, related: () => string, delay = 0, force = false): void {
    clearTimeout(this.timer)
    if (!enabled() || (!force && !hasRecentEdit())) return
    const id = ++this.requestId
    this.timer = setTimeout(() => void this.request(id, related()), delay)
  }

  private async request(id: number, related: string): Promise<void> {
    const position = this.editor.getPosition()
    if (!position) return
    const text = this.model.getValue()
    try {
      const suggestion = await window.galaxy.editor.suggestEdit({ path: this.path, text, offset: this.model.getOffsetAt(position), related, edits: recentEditsText() })
      if (id !== this.requestId || !suggestion || this.model.getValue() !== text) return
      this.show(suggestion)
    } catch {
      // A failed prediction is only a missing suggestion.
    }
  }

  private show(suggestion: EditSuggestion): void {
    this.clear()
    this.current = suggestion
    const { startLine, endLine } = suggestion
    if (endLine >= startLine) {
      this.decorations.set([{ range: new monaco.Range(startLine, 1, endLine, 1), options: { isWholeLine: true, className: 'galaxy-suggest-old', linesDecorationsClassName: 'galaxy-suggest-old-gutter' } }])
    }
    const lines = suggestion.text === '' ? [] : suggestion.text.split('\n')
    this.editor.changeViewZones((zones) => {
      const dom = document.createElement('div')
      dom.className = 'galaxy-suggest-new'
      for (const line of lines.length ? lines : ['']) {
        const row = document.createElement('div')
        row.textContent = line === '' ? ' ' : line
        dom.appendChild(row)
      }
      const hint = document.createElement('span')
      hint.className = 'galaxy-suggest-hint'
      hint.textContent = lines.length ? 'Tab' : 'Tab to delete'
      dom.firstElementChild?.appendChild(hint)
      this.zone = zones.addZone({ afterLineNumber: Math.max(endLine, startLine - 1), heightInLines: Math.max(1, lines.length), domNode: dom })
    })
    this.key.set(true)
    this.editor.revealLinesInCenterIfOutsideViewport(Math.max(1, startLine - 1), Math.max(endLine, startLine) + 1)
  }

  /** Applies the suggestion. Returns whether there was one, so the caller can ask for the one that follows. */
  accept(): boolean {
    const suggestion = this.current
    if (!suggestion) return false
    this.applying = true
    try {
      const { startLine, endLine, text } = suggestion
      const lastLine = this.model.getLineCount()
      const maxColumn = (line: number): number => this.model.getLineMaxColumn(line)
      let range: monaco.Range
      let insert = text
      if (endLine < startLine) {
        // Only new lines: after the last line they follow a line break, anywhere else they sit before the line that follows.
        if (startLine > lastLine) {
          range = new monaco.Range(lastLine, maxColumn(lastLine), lastLine, maxColumn(lastLine))
          insert = `\n${text}`
        } else {
          range = new monaco.Range(startLine, 1, startLine, 1)
          insert = `${text}\n`
        }
      } else if (text !== '') {
        range = new monaco.Range(startLine, 1, endLine, maxColumn(endLine))
      } else if (endLine < lastLine) {
        range = new monaco.Range(startLine, 1, endLine + 1, 1)
      } else if (startLine > 1) {
        range = new monaco.Range(startLine - 1, maxColumn(startLine - 1), endLine, maxColumn(endLine))
      } else {
        range = new monaco.Range(1, 1, endLine, maxColumn(endLine))
      }
      this.editor.executeEdits('galaxy-edit-suggestion', [{ range, text: insert }])
      const count = text === '' ? 0 : text.split('\n').length
      const line = Math.min(Math.max(1, (endLine < startLine && startLine > lastLine ? lastLine + 1 : startLine) + count - 1), this.model.getLineCount())
      this.editor.setPosition({ lineNumber: line, column: maxColumn(line) })
    } finally {
      this.applying = false
      this.clear()
    }
    return true
  }

  clear(): void {
    clearTimeout(this.timer)
    this.requestId++
    this.current = null
    this.decorations.clear()
    if (this.zone) {
      const zone = this.zone
      this.zone = null
      this.editor.changeViewZones((zones) => zones.removeZone(zone))
    }
    this.key.set(false)
  }

  dispose(): void {
    this.clear()
    this.content.dispose()
    this.cursor.dispose()
  }
}
