import { diffLines } from 'diff'
import { CornerDownLeft, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { InlineModel } from '@shared/models'
import { applyMonacoTheme, monaco } from '../lib/monaco'
import { useStore } from '../store'
import { Dropdown, Spinner } from './ui'

type Editor = monaco.editor.IStandaloneCodeEditor

interface InlineEditState {
  start: number
  end: number
  instruction: string
  busy: boolean
  error: string
}

/** A model's answer, shown in place until the user approves or declines it. */
interface Proposal {
  requestId: string
  start: number
  end: number
  text: string
  done: boolean
}

/** What each open editor needs from the shared completion provider and accept command. */
interface EditorHooks {
  editor: Editor
  path: string
  onCompleting(completing: boolean): void
  onAccepted(start: number, text: string, next: string | null): void
}

const hooks = new Map<string, EditorHooks>()
let completionsOn = true
const COMPLETION_DELAY = 300

function sleep(ms: number, token: monaco.CancellationToken): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(!token.isCancellationRequested), ms)
    token.onCancellationRequested(() => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

let registered = false
/** One inline completion provider for every editor; it asks the main process and shows the answer as ghost text. */
function registerCompletions(): void {
  if (registered) return
  registered = true
  monaco.editor.registerCommand('galaxy.completionAccepted', (_accessor, uri: string, start: number, text: string, next: string | null) => {
    hooks.get(uri)?.onAccepted(start, text, next)
  })
  monaco.languages.registerInlineCompletionsProvider({ pattern: '**' }, {
    async provideInlineCompletions(model, position, _context, token) {
      const hook = hooks.get(model.uri.toString())
      if (!hook || !completionsOn || hook.editor.getOption(monaco.editor.EditorOption.readOnly)) return { items: [] }
      if (!(await sleep(COMPLETION_DELAY, token))) return { items: [] }
      const text = model.getValue()
      const offset = model.getOffsetAt(position)
      hook.onCompleting(true)
      try {
        const result = await window.galaxy.editor.complete({ path: hook.path, prefix: text.slice(0, offset), suffix: text.slice(offset) })
        if (token.isCancellationRequested || !result.text.trim() || model.getValue() !== text) return { items: [] }
        // Ghost text must start at the cursor, so an addition further on carries the text in between.
        const at = offset + result.offset
        const insert = text.slice(offset, at) + result.text
        const end = model.getPositionAt(at)
        return {
          items: [
            {
              insertText: insert,
              range: new monaco.Range(position.lineNumber, position.column, end.lineNumber, end.column),
              command: { id: 'galaxy.completionAccepted', title: '', arguments: [model.uri.toString(), offset, insert, result.next] }
            }
          ]
        }
      } finally {
        hook.onCompleting(false)
      }
    },
    freeInlineCompletions() {}
  })
}

/**
 * The file editor, built on Monaco. Ghost-text completions accept with Tab, and a second Tab
 * jumps to where the model expects the next edit. Ctrl+I opens an inline edit, Ctrl+S saves.
 */
export function CodeEditor({ path, initial, line, onDirtyChange, onCompletingChange }: { path: string; initial: string; line?: number; onDirtyChange?(dirty: boolean): void; onCompletingChange?(completing: boolean): void }): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const savedVersion = useRef(0)
  const [edit, setEdit] = useState<InlineEditState | null>(null)
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [boxTop, setBoxTop] = useState<number | null>(null)
  const tabCompletion = useStore((s) => s.settings.tabCompletion !== false)
  const inlineModelId = useStore((s) => s.settings.inlineModelId)
  const update = useStore((s) => s.updateSettings)
  const notify = useStore((s) => s.notify)
  const latest = useRef({ path, onDirtyChange, onCompletingChange, notify })
  latest.current = { path, onDirtyChange, onCompletingChange, notify }
  /** Things the inline edit needs to put back or clean up. */
  const inline = useRef<{ zone: string | null; decorations: monaco.editor.IEditorDecorationsCollection | null; original: string; shownLength: number; stopped: string | null; proposalKey: monaco.editor.IContextKey<boolean> | null }>({
    zone: null,
    decorations: null,
    original: '',
    shownLength: 0,
    stopped: null,
    proposalKey: null
  })
  const openInlineEdit = useRef<() => void>(() => {})
  const declineRef = useRef<() => void>(() => {})

  useEffect(() => {
    completionsOn = tabCompletion
  }, [tabCompletion])

  // Create the editor once per file.
  useEffect(() => {
    if (!host.current) return
    registerCompletions()
    applyMonacoTheme()
    const uri = monaco.Uri.file(path)
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(initial, undefined, uri)
    if (model.getValue() !== initial) model.setValue(initial)
    const editor = monaco.editor.create(host.current, {
      model,
      automaticLayout: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'Menlo, monospace',
      fontSize: 12,
      lineHeight: 19,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      padding: { top: 8, bottom: 8 },
      inlineSuggest: { enabled: true, mode: 'subwordSmart' },
      tabSize: 2,
      detectIndentation: true,
      smoothScrolling: true,
      stickyScroll: { enabled: false },
      overviewRulerLanes: 0,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 }
    })
    editorRef.current = editor
    savedVersion.current = model.getAlternativeVersionId()

    // A predicted next edit spot, offered after a completion is accepted.
    const jumpKey = editor.createContextKey<boolean>('galaxyJump', false)
    inline.current.proposalKey = editor.createContextKey<boolean>('galaxyProposal', false)
    const jumpMark = editor.createDecorationsCollection()
    let jump: number | null = null
    const clearJump = (): void => {
      jump = null
      jumpKey.set(false)
      jumpMark.clear()
    }
    hooks.set(uri.toString(), {
      editor,
      path,
      onCompleting: (completing) => latest.current.onCompletingChange?.(completing),
      onAccepted(start, text, next) {
        clearJump()
        if (!next) return
        const found = model.getValue().indexOf(next, start + text.length)
        if (found === -1) return
        jump = found + next.length
        const at = model.getPositionAt(jump)
        jumpKey.set(true)
        jumpMark.set([{ range: new monaco.Range(at.lineNumber, at.column, at.lineNumber, at.column), options: { afterContentClassName: 'galaxy-jump-mark', stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } }])
      }
    })
    editor.addCommand(monaco.KeyCode.Tab, () => {
      if (jump === null) return
      const at = model.getPositionAt(Math.min(jump, model.getValueLength()))
      clearJump()
      editor.setPosition(at)
      editor.revealPositionInCenterIfOutsideViewport(at)
      editor.trigger('galaxy', 'editor.action.inlineSuggest.trigger', {})
    }, 'galaxyJump && !inlineSuggestionVisible && !suggestWidgetVisible')
    const keys = editor.onKeyDown((event) => {
      if (event.keyCode !== monaco.KeyCode.Tab && event.keyCode !== monaco.KeyCode.Shift) clearJump()
    })
    const mouse = editor.onMouseDown(clearJump)

    const save = async (): Promise<void> => {
      const text = model.getValue()
      const version = model.getAlternativeVersionId()
      try {
        await window.galaxy.files.write(latest.current.path, text)
        savedVersion.current = version
        latest.current.onDirtyChange?.(model.getAlternativeVersionId() !== savedVersion.current)
      } catch (error) {
        latest.current.notify(`Could not save: ${String(error)}`, 'error')
      }
    }
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save())
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI, () => openInlineEdit.current())
    editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyI, () => openInlineEdit.current())
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ, () => declineRef.current(), 'galaxyProposal')
    const changes = model.onDidChangeContent(() => latest.current.onDirtyChange?.(model.getAlternativeVersionId() !== savedVersion.current))

    return () => {
      keys.dispose()
      mouse.dispose()
      changes.dispose()
      hooks.delete(uri.toString())
      editor.dispose()
      model.dispose()
      editorRef.current = null
    }
    // The editor lives as long as the file; text updates are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // A reload from disk replaces the text only when there are no unsaved changes.
  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (!model || model.getValue() === initial) return
    if (model.getAlternativeVersionId() !== savedVersion.current) return
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: initial }], () => null)
    savedVersion.current = model.getAlternativeVersionId()
  }, [initial])

  // Follow the app's light and dark theme.
  useEffect(() => {
    const observer = new MutationObserver(applyMonacoTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !line) return
    editor.revealLineInCenter(line)
    editor.setPosition({ lineNumber: line, column: 1 })
    const mark = editor.createDecorationsCollection([{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'galaxy-target-line' } }])
    return () => mark.clear()
  }, [line, path])

  // Inline edit

  const modelId = InlineModel.some((m) => m.ID === inlineModelId) ? (inlineModelId as string) : InlineModel[0].ID

  /** Puts the code back to how it was before the edit started and removes everything the edit drew. */
  const restore = (): void => {
    const editor = editorRef.current
    const model = editor?.getModel()
    const state = inline.current
    if (!editor || !model) return
    if (proposal) {
      const start = model.getPositionAt(proposal.start)
      const end = model.getPositionAt(proposal.start + state.shownLength)
      model.applyEdits([{ range: monaco.Range.fromPositions(start, end), text: state.original }])
    }
    state.shownLength = 0
    clearDrawn()
    editor.updateOptions({ readOnly: false })
    state.proposalKey?.set(false)
  }

  const clearDrawn = (): void => {
    const editor = editorRef.current
    inline.current.decorations?.clear()
    editor?.changeViewZones((zones) => {
      for (const id of diffZones.current) zones.removeZone(id)
    })
    diffZones.current = []
  }
  const diffZones = useRef<string[]>([])

  const placeBox = (afterOffset: number): void => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model) return
    const lineNumber = model.getPositionAt(afterOffset).lineNumber
    editor.changeViewZones((zones) => {
      if (inline.current.zone) zones.removeZone(inline.current.zone)
      const dom = document.createElement('div')
      inline.current.zone = zones.addZone({ afterLineNumber: lineNumber, heightInPx: 104, domNode: dom, onDomNodeTop: (top) => setBoxTop(top) })
    })
  }

  const closeBox = (): void => {
    const editor = editorRef.current
    editor?.changeViewZones((zones) => {
      if (inline.current.zone) zones.removeZone(inline.current.zone)
    })
    inline.current.zone = null
    setBoxTop(null)
    setEdit(null)
  }

  openInlineEdit.current = () => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model || proposal) return
    const selection = editor.getSelection()
    if (!selection) return
    let start = model.getOffsetAt(selection.getStartPosition())
    let end = model.getOffsetAt(selection.getEndPosition())
    // Without a selection, new code goes on the lines below the cursor's line.
    if (start === end) start = end = model.getOffsetAt({ lineNumber: selection.endLineNumber, column: model.getLineMaxColumn(selection.endLineNumber) })
    inline.current.decorations?.clear()
    if (start !== end) inline.current.decorations = editor.createDecorationsCollection([{ range: selection, options: { className: 'galaxy-edit-selection' } }])
    setEdit({ start, end, instruction: edit?.instruction ?? '', busy: false, error: '' })
    placeBox(end)
  }

  /** The text that goes into the file for an answer: new code without a selection becomes its own lines. */
  const insertedText = (p: Proposal): string => (p.start === p.end ? `\n${p.text.replace(/^\n+|\n+$/g, '')}` : p.text)

  /** Shows the answer in place: plain while it streams. */
  const showText = (p: Proposal): void => {
    const model = editorRef.current?.getModel()
    if (!model) return
    const text = insertedText(p)
    const start = model.getPositionAt(p.start)
    const end = model.getPositionAt(p.start + inline.current.shownLength)
    model.applyEdits([{ range: monaco.Range.fromPositions(start, end), text }])
    inline.current.shownLength = text.length
    placeBox(p.start + text.length)
  }

  /** Once the answer is complete: added lines in green, removed lines in red above them. */
  const showDiff = (p: Proposal): void => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model) return
    clearDrawn()
    const text = insertedText(p)
    const value = model.getValue()
    const regionStart = value.lastIndexOf('\n', p.start - 1) + 1
    const after = value.indexOf('\n', p.start + text.length)
    const regionEnd = after === -1 ? value.length : after
    const original = value.slice(0, p.start) + inline.current.original + value.slice(p.start + text.length)
    const oldEnd = regionEnd - text.length + inline.current.original.length
    const oldBlock = original.slice(regionStart, oldEnd)
    const newBlock = value.slice(regionStart, regionEnd)
    let lineNumber = model.getPositionAt(regionStart).lineNumber
    const added: monaco.editor.IModelDeltaDecoration[] = []
    const removed: { after: number; lines: string[] }[] = []
    for (const part of diffLines(`${oldBlock}\n`, `${newBlock}\n`)) {
      const lines = part.value.replace(/\n$/, '').split('\n')
      if (part.removed) removed.push({ after: lineNumber - 1, lines })
      else {
        if (part.added) added.push({ range: new monaco.Range(lineNumber, 1, lineNumber + lines.length - 1, 1), options: { isWholeLine: true, className: 'galaxy-diff-add', linesDecorationsClassName: 'galaxy-diff-add-gutter' } })
        lineNumber += lines.length
      }
    }
    inline.current.decorations = editor.createDecorationsCollection(added)
    const language = model.getLanguageId()
    editor.changeViewZones((zones) => {
      for (const block of removed) {
        const dom = document.createElement('div')
        dom.className = 'galaxy-diff-del'
        void monaco.editor.colorize(block.lines.join('\n'), language, { tabSize: 2 }).then((html) => (dom.innerHTML = html))
        diffZones.current.push(zones.addZone({ afterLineNumber: block.after, heightInLines: block.lines.length, domNode: dom }))
      }
    })
    placeBox(regionEnd)
  }

  const runInlineEdit = async (): Promise<void> => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model || !edit || !edit.instruction.trim() || edit.busy) return
    const text = model.getValue()
    const requestId = crypto.randomUUID()
    const start = { requestId, start: edit.start, end: edit.end, text: '', done: false }
    inline.current.original = text.slice(edit.start, edit.end)
    inline.current.shownLength = edit.end - edit.start
    inline.current.decorations?.clear()
    editor.updateOptions({ readOnly: true })
    inline.current.proposalKey?.set(true)
    setEdit({ ...edit, busy: true, error: '' })
    setProposal(start)
    // The selected code disappears while the answer streams in its place.
    showText(start)
    let current = start
    const stop = window.galaxy.onUiEvent((event) => {
      if (event.type !== 'inline-edit-delta' || event.requestId !== requestId || inline.current.stopped === requestId) return
      current = { ...current, text: event.text }
      showText(current)
      setProposal(current)
    })
    try {
      const replacement = await window.galaxy.editor.inlineEdit({
        path,
        before: text.slice(0, edit.start),
        selection: text.slice(edit.start, edit.end),
        after: text.slice(edit.end),
        instruction: edit.instruction.trim(),
        modelId,
        requestId
      })
      if (inline.current.stopped === requestId) return
      current = { ...current, text: replacement, done: true }
      showText(current)
      showDiff(current)
      setProposal(current)
      setEdit((state) => (state ? { ...state, busy: false } : state))
    } catch (error) {
      if (inline.current.stopped === requestId) return
      restoreFor(current)
      setProposal(null)
      setEdit((state) => (state ? { ...state, busy: false, error: String(error instanceof Error ? error.message : error) } : state))
      placeBox(edit.end)
    } finally {
      stop()
    }
  }

  /** restore() for a proposal that is not in state yet. */
  const restoreFor = (p: Proposal): void => {
    const model = editorRef.current?.getModel()
    if (!model) return
    model.applyEdits([{ range: monaco.Range.fromPositions(model.getPositionAt(p.start), model.getPositionAt(p.start + inline.current.shownLength)), text: inline.current.original }])
    inline.current.shownLength = 0
    clearDrawn()
    editorRef.current?.updateOptions({ readOnly: false })
    inline.current.proposalKey?.set(false)
  }

  /** Stopping a running edit goes back to the instruction, so it can be changed and sent again. */
  const stopInlineEdit = (): void => {
    if (!proposal || !edit) return
    inline.current.stopped = proposal.requestId
    void window.galaxy.editor.cancelInlineEdit(proposal.requestId)
    restore()
    setProposal(null)
    setEdit({ ...edit, busy: false, error: '' })
    placeBox(edit.end)
  }

  const decline = (): void => {
    const editor = editorRef.current
    if (proposal && !proposal.done) {
      inline.current.stopped = proposal.requestId
      void window.galaxy.editor.cancelInlineEdit(proposal.requestId)
    }
    restore()
    inline.current.decorations?.clear()
    setProposal(null)
    closeBox()
    if (editor && edit) {
      const model = editor.getModel()!
      editor.focus()
      editor.setSelection(monaco.Range.fromPositions(model.getPositionAt(edit.start), model.getPositionAt(edit.end)))
    }
  }
  declineRef.current = decline

  /** Puts the answer in for real, as one step that Ctrl+Z undoes. */
  const approve = (): void => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model || !proposal?.done) return
    const text = insertedText(proposal)
    restore()
    setProposal(null)
    closeBox()
    const range = monaco.Range.fromPositions(model.getPositionAt(proposal.start), model.getPositionAt(proposal.end))
    editor.pushUndoStop()
    editor.executeEdits('inline-edit', [{ range, text }])
    editor.pushUndoStop()
    editor.focus()
    const from = proposal.start + (proposal.start === proposal.end ? 1 : 0)
    editor.setSelection(monaco.Range.fromPositions(model.getPositionAt(from), model.getPositionAt(proposal.start + text.length)))
  }

  return (
    <div className="relative h-full">
      <div ref={host} className="h-full" />
      {edit && boxTop !== null && (
        <InlineEditBox
          top={boxTop + 6}
          proposal={proposal}
          onApprove={approve}
          onStop={stopInlineEdit}
          state={edit}
          modelId={modelId}
          onModel={(id) => void update({ inlineModelId: id })}
          onChange={(instruction) => setEdit({ ...edit, instruction })}
          onSubmit={() => void runInlineEdit()}
          onClose={decline}
        />
      )}
    </div>
  )
}

export function InlineEditBox({
  top,
  bottom,
  placeholder,
  preview,
  proposal,
  onApprove,
  onStop,
  state,
  modelId,
  onModel,
  onChange,
  onSubmit,
  onClose
}: {
  top?: number
  /** Places the box from the bottom instead, as in the terminal. */
  bottom?: number
  placeholder?: string
  /** The answer shown inside the box, when there is no editor to show it in. */
  preview?: string
  proposal: Pick<Proposal, 'done'> | null
  onApprove(): void
  onStop(): void
  state: Pick<InlineEditState, 'instruction' | 'busy' | 'error'> & Partial<Pick<InlineEditState, 'start' | 'end'>>
  modelId: string
  onModel(id: string): void
  onChange(instruction: string): void
  onSubmit(): void
  onClose(): void
}): ReactNode {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!proposal) input.current?.focus()
  }, [proposal])
  const model = InlineModel.find((m) => m.ID === modelId) ?? InlineModel[0]
  return (
    <div
      className="absolute inset-x-3 z-20 mx-auto max-w-[560px] rounded-xl border border-line-strong bg-elev px-3.5 pb-3 pt-2.5 font-sans shadow-pop"
      style={{ top, bottom }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-start gap-2">
        <input
          ref={input}
          value={state.instruction}
          readOnly={state.busy || !!proposal}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && proposal) {
              event.preventDefault()
              onClose()
              return
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              if (proposal?.done) onApprove()
              else if (!proposal) onSubmit()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              if (proposal && !proposal.done) onStop()
              else onClose()
            }
          }}
          placeholder={placeholder ?? (state.start === state.end ? 'Enter instruction to write code here' : 'Enter instruction')}
          className="min-w-0 flex-1 bg-transparent py-0.5 text-[13px] text-fg outline-none placeholder:text-subtle"
        />
        <button type="button" aria-label="Close" onClick={onClose} className="mt-1 text-subtle hover:text-fg">
          <X size={14} />
        </button>
      </div>
      {preview !== undefined && (preview || !proposal?.done) && (
        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-inset px-2.5 py-1.5 font-mono text-[12px] text-fg">{preview || ' '}</pre>
      )}
      {state.error && <div className="mt-1 text-[12px] text-danger">{state.error}</div>}
      <div className="mt-2.5 flex items-center justify-between gap-3">
        <Dropdown
          label="Inline edit model"
          value={model.ID as string}
          disabled={state.busy}
          onChange={onModel}
          options={InlineModel.map((entry) => ({ value: entry.ID as string, label: entry.DisplayName }))}
          placement="top-start"
          className="h-auto! gap-1! bg-transparent! px-0! text-muted! hover:text-fg!"
        />
        {proposal ? (
          <div className="flex shrink-0 items-center gap-1.5">
            {!proposal.done && (
              <span className="flex items-center gap-1.5 pr-1 text-[12px] text-muted">
                <Spinner size={12} /> <span className="shimmer">Generating</span>
              </span>
            )}
            <button type="button" onClick={proposal.done ? onClose : onStop} className="flex h-6.5 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted hover:bg-hover hover:text-fg">
              {proposal.done ? 'Decline' : 'Stop'} <span className="text-[11px] text-subtle">Esc</span>
            </button>
            <button
              type="button"
              disabled={!proposal.done}
              onClick={onApprove}
              className="flex h-6.5 items-center gap-1.5 rounded-md bg-accent px-2 text-[12px] font-medium text-on-accent hover:opacity-90 disabled:opacity-40"
            >
              Approve <CornerDownLeft size={12.5} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={!state.instruction.trim()}
            onClick={onSubmit}
            className="flex h-6.5 shrink-0 items-center gap-1.5 rounded-md bg-accent px-2 text-[12px] font-medium text-on-accent hover:opacity-90 disabled:opacity-40"
          >
            Submit <CornerDownLeft size={12.5} />
          </button>
        )}
      </div>
    </div>
  )
}
