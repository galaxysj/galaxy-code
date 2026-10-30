import hljs from 'highlight.js/lib/common'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Copy,
  Pin,
  Pencil,
  Code,
  ExternalLink,
  Eye,
  FileDiff as FileDiffIcon,
  FileQuestion,
  FileText,
  FolderOpen,
  Globe,
  Hammer,
  MessageSquareDiff,
  MessagesSquare,
  GitCompare,
  CloudUpload,
  GitCommitHorizontal,
  Plus,
  PanelRight,
  SquareCheck,
  SquareDashed,
  SquareTerminal,
  RotateCw,
  X
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { FileView, FileDiff } from '@shared/types'
import type { ReviewCommit } from '@shared/api'
import { isReviewTextDiff } from '@shared/review'
import { basename, cn, formatBytes, languageForPath, relativeTo } from '../lib/utils'
import { useStore, type OpenFile, type PanelTab } from '../store'
import { LiveMarkdown } from './LiveMarkdown'
import { Markdown } from './Markdown'
import { Button, CopyButton, Dropdown, IconButton, MenuItem, MenuSeparator, Popover, Segmented, Spinner, usePopoverShown, type DropdownOption } from './ui'
import { DiffView, DiffStat } from './DiffView'
import { AgentTimeline } from './timeline/Timeline'
import { ProjectFilesPane } from './ProjectFiles'
import { CodeEditor, InlineEditBox } from './CodeEditor'
import { InlineModel, usableUtilityModels } from '@shared/models'
import { CloseSideChatDialog, SideChatPane } from './SideChat'
import { cleanError } from './Settings'
import { isInstant, runGitCommand } from '../lib/gitCommands'
import type { GitCommand } from '@shared/types'

// Browser

const WINDOW_SESSION = crypto.randomUUID()
const BLANK_BROWSER = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, agentActive: false }

function BrowserPane({ visible, tabId, root }: { visible: boolean; tabId: string; root: string | null }): ReactNode {
  const state = useStore((s) => s.browserStates[tabId] ?? BLANK_BROWSER)
  const host = useRef<HTMLDivElement>(null)
  const [address, setAddress] = useState(state.url)
  const [editing, setEditing] = useState(false)
  const hasPage = state.url !== ''
  const createTab = useStore((s) => s.createPanelTab)
  const openSideChat = useStore((s) => s.openSideChat)
  const covered = usePopoverShown()
  // A still of the page, shown in place of the native view while a popover needs to sit above it.
  const [frame, setFrame] = useState<string | null>(null)
  const stepAside = covered && !!frame

  useEffect(() => {
    if (!editing) setAddress(state.url)
  }, [state.url, editing])

  useEffect(() => {
    if (covered && visible && hasPage) {
      let alive = true
      void window.galaxy.browser.frame(tabId).then((image) => { if (alive) setFrame(image) }).catch(() => {})
      return () => { alive = false }
    }
    // The still stays a moment so the page does not blink while the native view comes back.
    const timer = window.setTimeout(() => setFrame(null), 150)
    return () => window.clearTimeout(timer)
  }, [covered, visible, hasPage, tabId])

  // The page is a native view layered over the window; keep it glued to this placeholder.
  const sync = useCallback(() => {
    const el = host.current
    if (!el || !visible || !hasPage || stepAside) {
      void window.galaxy.browser.setBounds(null, tabId)
      return
    }
    const rect = el.getBoundingClientRect()
    void window.galaxy.browser.setBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }, tabId)
  }, [visible, hasPage, stepAside, tabId])

  useLayoutEffect(() => {
    sync()
    const el = host.current
    if (!el) return
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    window.addEventListener('resize', sync)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [sync])

  useEffect(() => () => void window.galaxy.browser.setBounds(null, tabId), [tabId])

  const go = (): void => {
    const value = address.trim()
    if (value) void window.galaxy.browser.navigate(value, tabId).catch((error) => useStore.getState().notify(String(error), 'error'))
    setEditing(false)
  }

  return (
    <div className={cn('flex h-full flex-col', !visible && 'hidden')}>
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-line px-2">
        <IconButton label="Back" disabled={!state.canGoBack} onClick={() => void window.galaxy.browser.back(tabId)}>
          <ArrowLeft size={14.5} />
        </IconButton>
        <IconButton label="Forward" disabled={!state.canGoForward} onClick={() => void window.galaxy.browser.forward(tabId)}>
          <ArrowRight size={14.5} />
        </IconButton>
        <IconButton label={state.loading ? 'Stop' : 'Reload'} disabled={!hasPage} onClick={() => void (state.loading ? window.galaxy.browser.stop(tabId) : window.galaxy.browser.reload(tabId))}>
          {state.loading ? <X size={14.5} /> : <RotateCw size={13.5} />}
        </IconButton>
        <div className="mx-1 flex h-7 min-w-0 flex-1 items-center gap-2 rounded-lg bg-inset px-2.5 shadow-[0_0_0_1px_var(--border)] focus-within:shadow-[0_0_0_1px_var(--border-strong)]">
          {state.loading ? <Spinner size={12} className="text-subtle" /> : <Globe size={12.5} className="shrink-0 text-subtle" />}
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => {
              setEditing(true)
              event.target.select()
            }}
            onBlur={() => setEditing(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                go()
                event.currentTarget.blur()
              }
              if (event.key === 'Escape') {
                setAddress(state.url)
                event.currentTarget.blur()
              }
            }}
            placeholder="Search or enter a URL"
            className="h-full min-w-0 flex-1 bg-transparent font-mono text-[11.5px] placeholder:font-sans placeholder:text-subtle"
          />
          {state.agentActive && <span className="shimmer shrink-0 text-[11px]">Agent is browsing</span>}
        </div>
        <IconButton label="Open in default browser" disabled={!/^https?:/.test(state.url)} onClick={() => void window.galaxy.files.openExternal(state.url)}>
          <ExternalLink size={13.5} />
        </IconButton>
      </div>
      <div className="relative min-h-0 flex-1 p-1.5">
        <div ref={host} className="h-full w-full overflow-hidden rounded-lg">
          {frame && hasPage && <img src={frame} alt="" draggable={false} className="h-full w-full" />}
          {!hasPage && (
            <div className="flex h-full flex-col items-center justify-center gap-5 px-5 text-center">
              <div><div className="mb-2 text-[19px] font-medium text-fg">New tab</div><div className="text-[12px] text-subtle">Enter a website above, or open a tool.</div></div>
              <div className="grid w-full max-w-[460px] grid-cols-4 gap-2">
                {([{ type: 'file', label: 'Files', Icon: FolderOpen }, { type: 'terminal', label: 'Terminal', Icon: SquareTerminal }, { type: 'review', label: 'Review', Icon: GitCompare }, { type: 'side', label: 'Side chat', Icon: MessagesSquare }] as const).map(({ type, label, Icon }) => <button key={type} type="button" disabled={type === 'file' && !root} title={type === 'file' && !root ? 'Select a project to browse files' : label} onClick={() => { if (type === 'side') { useStore.getState().closePanelTab(tabId); void openSideChat() } else void createTab(type, root, tabId) }} className="flex min-w-0 flex-col items-center gap-2 rounded-xl border border-line bg-elev px-2 py-4 text-[12px] text-muted transition-all hover:border-line-strong hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-40 disabled:hover:bg-elev"><Icon size={18} /><span>{label}</span></button>)}
              </div>
              {!root && <div className="text-[11.5px] text-subtle">Choose a project to enable Files.</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Files

const LINE_HEIGHT = 19

function SourceView({ content, path, line }: { content: string; path: string; line?: number }): ReactNode {
  const scroller = useRef<HTMLDivElement>(null)
  const language = languageForPath(path)
  const lines = useMemo(() => content.replace(/\n$/, '').split('\n'), [content])
  const html = useMemo(() => {
    if (!language || !hljs.getLanguage(language) || content.length > 400_000) return null
    try {
      return hljs.highlight(content, { language, ignoreIllegals: true }).value
    } catch {
      return null
    }
  }, [content, language])
  const width = String(lines.length).length

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    el.scrollTop = line ? Math.max(0, (line - 1) * LINE_HEIGHT - el.clientHeight / 3) : 0
  }, [line, path])

  return (
    <div ref={scroller} className="selectable h-full overflow-auto font-mono text-[12px]" style={{ lineHeight: `${LINE_HEIGHT}px` }}>
      <div className="relative flex min-w-max py-2">
        {line && line <= lines.length && (
          <div className="pointer-events-none absolute inset-x-0 bg-warn/15" style={{ top: 8 + (line - 1) * LINE_HEIGHT, height: LINE_HEIGHT }} />
        )}
        <div className="sticky left-0 z-10 shrink-0 select-none bg-bg pl-3 pr-3 text-right text-subtle" style={{ width: `calc(${width}ch + 24px)` }}>
          {lines.map((_, index) => (
            <div key={index} className={cn(index + 1 === line && 'text-fg')}>
              {index + 1}
            </div>
          ))}
        </div>
        <pre className="relative pr-6">{html !== null ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{content}</code>}</pre>
      </div>
    </div>
  )
}

/** Plans written in Plan mode live directly in .galaxy/plans. */
const PLAN_FILE = /[/\\]\.galaxy[/\\]plans[/\\][^/\\]+\.md$/i

/** Sends the saved plan to the agent, without a mode, so it starts carrying it out. */
async function buildPlan(path: string, root: string | null): Promise<void> {
  const state = useStore.getState()
  const view = await window.galaxy.files.read(path)
  if (view.kind !== 'text' || !view.content?.trim()) {
    state.notify('The plan file is empty or could not be read.', 'error')
    return
  }
  const name = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
  state.setComposerMode(state.activeChatId ?? 'new', undefined)
  await state.send(`Build the plan in \`${name}\`. Follow it step by step and verify the result.\n\n${view.content.trim()}`, [], undefined, false, undefined, path)
}

function FilePane({ file, visible, root }: { file: OpenFile; visible: boolean; root: string | null }): ReactNode {
  const homeDir = useStore((s) => s.homeDir)
  const showBrowser = useStore((s) => s.showBrowser)
  const [view, setView] = useState<FileView | null>(null)
  const [mode, setMode] = useState<'preview' | 'source'>('preview')
  const [reload, setReload] = useState(0)
  const [dirty, setDirty] = useState(false)
  const savedText = useRef('')
  const liveText = useRef('')
  const [completing, setCompleting] = useState(false)

  // Reload when the agent finishes an edit to this file.
  const editStamp = useStore((s) => {
    const items = s.activeChatId ? s.items[s.activeChatId] : undefined
    if (!items) return 0
    let count = 0
    for (const item of items) {
      if (item.kind === 'tool' && item.status === 'done' && item.meta?.diffs?.some((d) => d.path === file.path)) count++
    }
    return count
  })

  const shownPath = useRef(file.path)
  useEffect(() => {
    let cancelled = false
    // A reload of the same file keeps the editor mounted, so unsaved edits survive it.
    if (shownPath.current !== file.path) {
      shownPath.current = file.path
      setView(null)
      setDirty(false)
    }
    void window.galaxy.files.read(file.path).then((result) => {
      if (cancelled) return
      setView(result)
      savedText.current = liveText.current = result.content ?? ''
    })
    return () => {
      cancelled = true
    }
  }, [file.path, file.nonce, reload, editStamp])

  const editLive = (text: string): void => {
    liveText.current = text
    setDirty(text !== savedText.current)
    // Source view opens from this too, so unsaved edits carry over.
    setView((current) => (current ? { ...current, content: text } : current))
  }
  const savedLive = (text: string): void => {
    savedText.current = text
    setDirty(liveText.current !== text)
  }
  const saveLive = (text: string): void => {
    liveText.current = text
    window.galaxy.files.write(file.path, text).then(() => savedLive(text)).catch((error: unknown) => useStore.getState().notify(String(error), 'error'))
  }

  const isMarkdown = /\.(md|mdx|markdown)$/i.test(file.path)
  const isHtml = /\.html?$/i.test(file.path)
  const isSvg = view?.mime === 'image/svg+xml'
  const hasPreview = isMarkdown || isSvg

  return (
    <div className={cn('flex h-full flex-col', !visible && 'hidden')}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line pl-3 pr-2">
        <span className="min-w-0 truncate font-mono text-[11.5px] text-muted" title={file.path}>
          {relativeTo(root, file.path, homeDir)}
        </span>
        {completing && (
          <span className="flex shrink-0 items-center px-1 text-subtle" title="Generating a suggestion">
            <Spinner size={11} />
          </span>
        )}
        {dirty && <span className="shrink-0 px-1 text-[11px] text-muted" title="Unsaved changes. Press Ctrl+S to save.">Edited</span>}
        <span className="flex-1" />
        {view && view.kind !== 'missing' && <span className="shrink-0 px-1 text-[11px] text-subtle">{formatBytes(view.size)}</span>}
        {hasPreview && view?.content !== undefined && (
          <Segmented<'preview' | 'source'>
            size="sm"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'preview', label: <Eye size={12} />, title: 'Preview' },
              { value: 'source', label: <Code size={12} />, title: 'Source' }
            ]}
          />
        )}
        {isHtml && (
          <IconButton
            label="Preview in the browser panel"
            onClick={() => {
              const tabId = `preview:${WINDOW_SESSION}:${file.path}`
              showBrowser(tabId)
              void window.galaxy.browser.navigate(`file://${file.path}`, tabId).catch((error) => useStore.getState().notify(String(error), 'error'))
            }}
          >
            <Globe size={13.5} />
          </IconButton>
        )}
        {view?.content !== undefined && <CopyButton text={view.content} label="Copy contents" />}
        <IconButton label="Reload" size="sm" onClick={() => setReload((n) => n + 1)}>
          <RotateCw size={12.5} />
        </IconButton>
        <IconButton label="Show in folder" size="sm" onClick={() => void window.galaxy.files.reveal(file.path)}>
          <FolderOpen size={13} />
        </IconButton>
        <IconButton label="Open with default app" size="sm" onClick={() => void window.galaxy.files.openExternal(file.path)}>
          <ExternalLink size={13} />
        </IconButton>
        {PLAN_FILE.test(file.path) && view?.kind === 'text' && (
          <Button variant="primary" size="sm" className="ml-1" disabled={dirty} title={dirty ? 'Save the plan before building' : 'Send this plan to the agent and start building'} onClick={() => void buildPlan(file.path, root)}>
            <Hammer size={12.5} />
            Build
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {!view ? (
          <div className="flex h-full items-center justify-center"><Spinner className="text-subtle" /></div>
        ) : view.kind === 'missing' ? (
          <Placeholder icon={<FileQuestion size={22} />} title="File not found" detail="It may have been moved or deleted." />
        ) : view.kind === 'binary' ? (
          <Placeholder icon={<FileText size={22} />} title="No preview for this file" detail="Open it with its default app instead." />
        ) : view.kind === 'image' && !(isSvg && mode === 'source') ? (
          <div className="flex h-full items-center justify-center overflow-auto p-6" style={{ background: 'repeating-conic-gradient(var(--bg-hover) 0% 25%, transparent 0% 50%) 50% / 18px 18px' }}>
            <img src={view.dataUrl} alt={view.name} className="max-h-full max-w-full rounded object-contain shadow-pop" draggable={false} />
          </div>
        ) : isMarkdown && mode === 'preview' && view.kind === 'text' && !view.truncated ? (
          <div className="flex h-full flex-col">
            <LiveMarkdown key={`${file.path}:${file.nonce}:${reload}:${editStamp}`} initial={view.content ?? ''} onChange={editLive} onSave={saveLive} />
          </div>
        ) : isMarkdown && mode === 'preview' ? (
          <div className="h-full overflow-y-auto px-6 py-5">
            <Markdown text={view.content ?? ''} root={file.path.slice(0, file.path.lastIndexOf('/'))} html />
          </div>
        ) : view.kind === 'text' && !view.truncated ? (
          <CodeEditor path={file.path} initial={view.content ?? ''} line={file.line} onDirtyChange={isMarkdown ? undefined : setDirty} onTextChange={isMarkdown ? editLive : undefined} onSaved={isMarkdown ? savedLive : undefined} onCompletingChange={setCompleting} />
        ) : (
          <SourceView content={view.content ?? ''} path={file.path} line={file.line} />
        )}
        {view?.truncated && <div className="border-t border-line px-3 py-1 text-[11px] text-subtle">Showing the first 1.5 MB of this file.</div>}
      </div>
    </div>
  )
}

function Placeholder({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-subtle">
      {icon}
      <div className="text-[13px] text-muted">{title}</div>
      <div className="text-[12px]">{detail}</div>
    </div>
  )
}

type WorkspaceTab = Extract<PanelTab, { cwd: string }>

function TerminalPane({ tab, visible }: { tab: WorkspaceTab; visible: boolean }): ReactNode {
  const output = useStore((s) => s.terminalOutput[tab.id])
  const notify = useStore((s) => s.notify)
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const fitAddon = useRef<FitAddon | null>(null)
  const showBrowser = useStore((s) => s.showBrowser)
  const inlineModelId = useStore((s) => s.settings.inlineModelId)
  const updateSettings = useStore((s) => s.updateSettings)
  const [ask, setAsk] = useState<{ instruction: string; busy: boolean; error: string } | null>(null)
  const [answer, setAnswer] = useState<{ requestId: string; text: string; done: boolean } | null>(null)
  const queueMention = useStore((s) => s.queueMention)
  const [selection, setSelection] = useState('')
  const addSelection = useRef<() => void>(() => {})
  addSelection.current = () => {
    const text = terminal.current?.getSelection() ?? ''
    if (!text.trim()) return
    const lines = text.replace(/\n$/, '').split('\n').length
    queueMention({ kind: 'terminal', name: `${tab.customTitle || tab.title} (${lines} ${lines === 1 ? 'line' : 'lines'})`, tabId: tab.id, cwd: tab.cwd, selection: text })
    terminal.current?.clearSelection()
  }
  const openAsk = useRef<() => void>(() => {})
  const stoppedAsk = useRef<string | null>(null)
  openAsk.current = () => {
    if (!output?.exited) setAsk((current) => current ?? { instruction: '', busy: false, error: '' })
  }
  const accounts = useStore((s) => s.settings.accounts)
  const modelId = usableUtilityModels(InlineModel, accounts).some((m) => m.ID === inlineModelId) ? (inlineModelId as string) : InlineModel[0].ID

  const generate = async (): Promise<void> => {
    if (!ask || !ask.instruction.trim() || ask.busy) return
    const requestId = crypto.randomUUID()
    setAsk({ ...ask, busy: true, error: '' })
    setAnswer({ requestId, text: '', done: false })
    const stop = window.galaxy.onUiEvent((event) => {
      if (event.type === 'inline-edit-delta' && event.requestId === requestId) setAnswer((current) => (current?.requestId === requestId ? { ...current, text: event.text } : current))
    })
    try {
      // The end of the output, without color codes, tells the model what just happened.
      const recent = (useStore.getState().terminalOutput[tab.id]?.text ?? '').slice(-6000).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07/g, '')
      const command = await window.galaxy.editor.terminalCommand({ instruction: ask.instruction.trim(), cwd: tab.cwd, output: recent, modelId, requestId })
      setAnswer((current) => (current?.requestId === requestId ? { ...current, text: command, done: true } : current))
      setAsk((current) => (current ? { ...current, busy: false } : current))
    } catch (error) {
      if (stoppedAsk.current === requestId) return
      setAnswer((current) => (current?.requestId === requestId ? null : current))
      setAsk((current) => (current ? { ...current, busy: false, error: String(error instanceof Error ? error.message : error) } : current))
    } finally {
      stop()
    }
  }

  const closeAsk = (): void => {
    if (answer && !answer.done) {
      stoppedAsk.current = answer.requestId
      void window.galaxy.editor.cancelInlineEdit(answer.requestId)
    }
    setAnswer(null)
    setAsk(null)
    terminal.current?.focus()
  }

  /** Types the command at the prompt without running it; Enter in the terminal runs it. */
  const insertCommand = (): void => {
    if (!answer?.done || !answer.text) return
    void window.galaxy.terminal.write(tab.id, answer.text).catch((error) => notify(String(error), 'error'))
    setAnswer(null)
    setAsk(null)
    terminal.current?.focus()
  }

  useEffect(() => {
    if (!host.current) return
    const term = new Terminal({
      cursorBlink: true, cursorStyle: 'bar', cursorWidth: 2, cursorInactiveStyle: 'bar', fontSize: 12, fontFamily: 'Menlo, Monaco, monospace',
      scrollback: 10000, allowProposedApi: false
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // Cmd+click (Ctrl+click elsewhere) opens a link in the built-in browser.
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (!(event.metaKey || event.ctrlKey)) return
        const tabId = `terminal-link:${crypto.randomUUID()}`
        showBrowser(tabId)
        void window.galaxy.browser.navigate(uri, tabId).catch((error) => notify(String(error), 'error'))
      })
    )
    // Cmd+I asks for a command. Ctrl+I stays Tab for the shell on macOS.
    const mac = navigator.platform.toLowerCase().includes('mac')
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && event.key.toLowerCase() === 'i' && (mac ? event.metaKey : event.ctrlKey && event.shiftKey)) {
        event.preventDefault()
        openAsk.current()
        return false
      }
      // Cmd+L adds the selected text to the chat. Ctrl+L still clears the screen in the shell.
      if (event.type === 'keydown' && event.key.toLowerCase() === 'l' && (mac ? event.metaKey : event.ctrlKey && event.shiftKey) && term.hasSelection()) {
        event.preventDefault()
        addSelection.current()
        return false
      }
      return true
    })
    const selected = term.onSelectionChange(() => setSelection(term.getSelection()))
    term.open(host.current)
    terminal.current = term
    fitAddon.current = fit
    const initial = useStore.getState().terminalOutput[tab.id]
    if (initial?.text) term.write(initial.text)
    term.options.disableStdin = initial?.exited ?? false
    const unsubscribe = window.galaxy.onUiEvent((event) => {
      if (event.type !== 'terminal-output' || event.tabId !== tab.id) return
      term.write(event.text)
      if (event.exited) term.options.disableStdin = true
    })
    const input = term.onData((data) => {
      void window.galaxy.terminal.write(tab.id, data).catch((error) => notify(String(error), 'error'))
    })
    const resize = term.onResize(({ cols, rows }) => {
      void window.galaxy.terminal.resize(tab.id, cols, rows).catch((error) => notify(String(error), 'error'))
    })
    const update = (): void => {
      const light = document.documentElement.dataset.theme === 'light'
      term.options.theme = {
        background: light ? '#ffffff' : '#000000',
        foreground: light ? '#26251e' : '#e7e7e5',
        cursor: light ? '#26251e' : '#e7e7e5',
        selectionBackground: light ? '#b8d6f5' : '#354b66'
      }
      if (host.current?.clientWidth && host.current.clientHeight) fit.fit()
    }
    const observer = new ResizeObserver(update)
    observer.observe(host.current)
    const themeObserver = new MutationObserver(update)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    update()
    return () => {
      unsubscribe()
      observer.disconnect()
      themeObserver.disconnect()
      input.dispose()
      resize.dispose()
      selected.dispose()
      term.dispose()
      terminal.current = null
      fitAddon.current = null
    }
  }, [tab.id, notify, showBrowser, queueMention])
  useEffect(() => {
    if (!visible) return
    const frame = requestAnimationFrame(() => {
      fitAddon.current?.fit()
      terminal.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [visible])
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted" title={tab.cwd}>{tab.cwd}</span>
        <CopyButton text={output?.text ?? ''} label="Copy terminal output" />
        <button type="button" disabled={output?.exited} onClick={() => void window.galaxy.terminal.interrupt(tab.id).catch((error) => notify(String(error), 'error'))} className="rounded-md px-2 py-1 text-[11px] text-muted hover:bg-hover disabled:opacity-40">Interrupt</button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={host} aria-label="Live terminal" className="h-full overflow-hidden p-3" />
        {selection.trim() && (
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => addSelection.current()}
            className="absolute right-3 top-2 z-10 flex h-6.5 items-center gap-1.5 rounded-md border border-line-strong bg-elev px-2 text-[12px] text-fg shadow-pop hover:bg-hover"
          >
            Add to Chat <span className="text-[11px] text-subtle">{navigator.platform.toLowerCase().includes('mac') ? '⌘L' : 'Ctrl+Shift+L'}</span>
          </button>
        )}
        {ask && (
          <InlineEditBox
            bottom={12}
            placeholder="Describe a command to run"
            preview={answer ? answer.text : undefined}
            proposal={answer}
            onApprove={insertCommand}
            onStop={() => {
              if (answer) {
                stoppedAsk.current = answer.requestId
                void window.galaxy.editor.cancelInlineEdit(answer.requestId)
              }
              setAnswer(null)
              setAsk({ ...ask, busy: false, error: '' })
            }}
            state={ask}
            modelId={modelId}
            onModel={(id) => void updateSettings({ inlineModelId: id })}
            onChange={(instruction) => setAsk({ ...ask, instruction })}
            onSubmit={() => void generate()}
            onClose={closeAsk}
          />
        )}
      </div>
    </div>
  )
}

type ReviewMode = 'last-turn' | 'uncommitted' | 'unstaged' | 'staged' | 'commit'

const REVIEW_MODES: DropdownOption<ReviewMode>[] = [
  { value: 'last-turn', label: 'Last turn', icon: <MessageSquareDiff size={13.5} /> },
  { value: 'uncommitted', label: 'Uncommitted', icon: <FileDiffIcon size={13.5} /> },
  { value: 'unstaged', label: 'Unstaged', icon: <SquareDashed size={13.5} /> },
  { value: 'staged', label: 'Staged', icon: <SquareCheck size={13.5} /> },
  { value: 'commit', label: 'Commit…', icon: <GitCommitHorizontal size={13.5} /> }
]

function ReviewPane({ tab, visible }: { tab: WorkspaceTab; visible: boolean }): ReactNode {
  const chatId = useStore((s) => tab.chatId ?? s.activeChatId)
  const items = useStore((s) => chatId ? s.items[chatId] : undefined)
  const chatStatus = useStore((s) => chatId ? s.chats[chatId]?.status : undefined)
  const [git, setGit] = useState<{ isRepo: boolean; dirty: boolean; hasRemote: boolean } | null>(null)
  const [gitMenu, setGitMenu] = useState(false)
  // An action picked from the menu takes the main button until it finishes.
  const [chosen, setChosen] = useState<'commit' | 'commit-push' | 'push' | null>(null)
  const [committing, setCommitting] = useState<GitCommand | null>(null)
  const commitStarted = useRef(false)
  const gitMenuAnchor = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<ReviewMode>('last-turn')
  const [commits, setCommits] = useState<ReviewCommit[] | null>(null)
  const [commitError, setCommitError] = useState('')
  const [commit, setCommit] = useState('')
  const [review, setReview] = useState<Awaited<ReturnType<typeof window.galaxy.review.read>> | null>(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [isRepo, setIsRepo] = useState<boolean | null>(null)
  const [repoError, setRepoError] = useState('')
  const [initError, setInitError] = useState('')
  const [initializing, setInitializing] = useState(false)
  useEffect(() => {
    if (!visible || mode !== 'commit') return
    let cancelled = false
    setIsRepo(null)
    setRepoError('')
    setInitError('')
    void window.galaxy.review.status(tab.cwd).then((value) => {
      if (!cancelled) setIsRepo(value.isRepo)
    }).catch((error) => { if (!cancelled) setRepoError(cleanError(error)) })
    return () => { cancelled = true }
  }, [tab.cwd, visible, reload, tab.nonce, mode])
  // The Git buttons follow the folder, whichever view is picked, and recheck when the agent finishes a turn.
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    void window.galaxy.review.state(tab.cwd).then((value) => { if (!cancelled) setGit(value) }).catch(() => { if (!cancelled) setGit(null) })
    return () => { cancelled = true }
  }, [tab.cwd, visible, reload, tab.nonce, chatStatus])
  // A commit is loading until the agent's turn for it ends.
  useEffect(() => {
    if (!committing) return
    if (chatStatus === 'running' || chatStatus === 'awaiting') commitStarted.current = true
    else if (commitStarted.current) {
      setCommitting(null)
      setChosen(null)
    }
  }, [committing, chatStatus])
  // Without a chat the command starts a new one.
  const askAgent = async (command: GitCommand): Promise<void> => {
    if (committing) return
    setCommitting(command)
    commitStarted.current = false
    if (isInstant(command)) {
      // No agent turn: loading ends when the commit or push does.
      await runGitCommand(command, chatId ?? null, tab.cwd)
      setCommitting(null)
      setChosen(null)
      setReload((value) => value + 1)
      return
    }
    await runGitCommand(command, chatId ?? null, tab.cwd).catch(() => {})
    // The message may not have started a turn, for example with no model chosen.
    setTimeout(() => {
      if (commitStarted.current) return
      setCommitting(null)
      setChosen(null)
    }, 5000)
  }
  const initialize = async (): Promise<void> => {
    if (initializing) return
    setInitializing(true)
    setInitError('')
    try {
      await window.galaxy.review.init(tab.cwd)
      setMode('uncommitted')
      setReload((value) => value + 1)
    } catch (error) {
      setInitError(cleanError(error))
    } finally {
      setInitializing(false)
    }
  }
  const diffs = useMemo(() => {
    const timeline = items ?? []
    const end = timeline.findLastIndex((item) => item.kind === 'turn' && !item.parentId)
    const previousTurn = end < 0 ? -1 : timeline.slice(0, end).findLastIndex((item) => item.kind === 'turn' && !item.parentId)
    // Use the agent's recorded diffs from its last completed turn. A new
    // user message must not replace this review before the agent finishes.
    const turnItems = end < 0 ? timeline : timeline.slice(previousTurn + 1, end)
    const files = new Map<string, FileDiff>()
    for (const item of turnItems) {
      if (item.kind !== 'tool' || item.status !== 'done' || item.tool !== 'edit' && item.tool !== 'create') continue
      for (const diff of item.meta?.diffs ?? []) {
        if (!isReviewTextDiff(diff)) continue
        files.set(diff.path, diff)
      }
    }
    return [...files.values()]
  }, [items])
  useEffect(() => {
    if (!visible || mode !== 'commit') return
    let cancelled = false
    setCommits(null)
    setCommitError('')
    void window.galaxy.review.commits(tab.cwd).then((list) => {
      if (cancelled) return
      setCommits(list)
      setCommit((selected) => list.some((entry) => entry.hash === selected) ? selected : list[0]?.hash ?? '')
    }).catch((error) => { if (!cancelled) setCommitError(cleanError(error)) })
    return () => { cancelled = true }
  }, [tab.cwd, visible, mode, reload, tab.nonce])
  useEffect(() => {
    if (!visible || mode === 'last-turn' || mode === 'commit' && !commit) return
    let cancelled = false
    setIsRepo(null)
    setRepoError('')
    setInitError('')
    setReview(null)
    setError('')
    void window.galaxy.review.read(tab.cwd, { mode, ...(mode === 'commit' ? { commit } : {}) }).then((value) => {
      if (!cancelled) {
        setReview(value)
        setIsRepo(value.isRepo)
      }
    }).catch((error) => { if (!cancelled) setError(cleanError(error)) })
    return () => { cancelled = true }
  }, [tab.cwd, visible, reload, tab.nonce, mode, commit])
  // Main action: Commit & Push, Commit when there is no remote, Push once everything is committed.
  const gitBusy = committing !== null
  const gitActions = {
    'commit-push': { label: 'Commit & Push', icon: committing === 'commit-push' ? <Spinner size={12} /> : <GitCommitHorizontal size={13} />, run: () => void askAgent('commit-push') },
    commit: { label: 'Commit', icon: committing === 'commit' ? <Spinner size={12} /> : <GitCommitHorizontal size={13} />, run: () => void askAgent('commit') },
    push: { label: 'Push', icon: committing === 'push' ? <Spinner size={12} /> : <CloudUpload size={13} />, run: () => void askAgent('push') }
  }
  // Committing needs uncommitted changes, and pushing needs a remote.
  const gitDisabled = (action: keyof typeof gitActions): boolean =>
    action !== 'push' && !git?.dirty || action !== 'commit' && !git?.hasRemote || gitBusy
  // With nothing to commit and no remote, all three are off and Commit shows.
  const primaryAction: keyof typeof gitActions = chosen ?? committing ?? (git?.dirty ? (git.hasRemote ? 'commit-push' : 'commit') : git?.hasRemote ? 'push' : 'commit')
  const lastTurn = mode === 'last-turn'
  const displayError = lastTurn ? '' : repoError || (mode === 'commit' ? commitError : '') || error
  const needsRepository = !lastTurn && isRepo === false
  const noCommits = mode === 'commit' && commits?.length === 0
  const loading = !lastTurn && !displayError && !needsRepository && (
    isRepo === null || (mode === 'commit' && commits === null) || (!noCommits && !review)
  )
  const displayedDiffs = lastTurn ? diffs : review?.diffs ?? []
  const centered = !!displayError || needsRepository || loading || noCommits || displayedDiffs.length === 0
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-line px-3 py-1">
        <Dropdown<ReviewMode> label="Review changes" value={mode} options={REVIEW_MODES} onChange={setMode} className="shrink-0" />
        <IconButton label="Refresh changes" onClick={() => setReload((value) => value + 1)}><RotateCw size={13} /></IconButton>
        {mode === 'commit' && isRepo === true && !!commits?.length && !commitError && (
          <Dropdown
            label="Select commit"
            value={commit}
            options={commits.map((entry) => ({ value: entry.hash, label: entry.subject, hint: entry.shortHash, title: `${entry.shortHash} · ${entry.subject} · ${entry.author}` }))}
            onChange={setCommit}
            className="w-0 flex-1"
            menuClassName="w-[360px]"
          />
        )}
        {git?.isRepo && (
          <div ref={gitMenuAnchor} className="ml-auto flex shrink-0 items-center">
            <Button size="sm" variant="primary" disabled={gitDisabled(primaryAction)} title={gitBusy || !gitDisabled(primaryAction) ? undefined : !git?.dirty ? 'There are no changes to commit.' : 'This repository has no remote.'} onClick={gitActions[primaryAction].run} className={cn('gap-1! rounded-r-none px-1.5!', gitBusy && 'disabled:opacity-100!')}>{gitActions[primaryAction].icon} {gitActions[primaryAction].label}</Button>
            <Button size="sm" variant="primary" aria-label="More Git actions" onClick={() => setGitMenu((open) => !open)} className={cn('w-4 rounded-l-none border-l border-white/20 px-0!', gitDisabled(primaryAction) && !gitBusy && 'opacity-45')}><ChevronDown size={12} /></Button>
            <Popover open={gitMenu} onClose={() => setGitMenu(false)} anchor={gitMenuAnchor} placement="bottom-end" className="w-48 p-1">
              {(Object.keys(gitActions) as (keyof typeof gitActions)[]).filter((action) => action !== primaryAction).map((action) => (
                <MenuItem key={action} icon={gitActions[action].icon} label={gitActions[action].label} disabled={gitDisabled(action)} onClick={() => { setGitMenu(false); setChosen(action); gitActions[action].run() }} />
              ))}
            </Popover>
          </div>
        )}
      </div>
      <div className={cn('selectable min-h-0 flex-1 overflow-auto px-4 py-3', centered && 'flex items-center justify-center text-center')}>
        {displayError ? <div role="alert" className="max-w-md whitespace-pre-wrap break-words text-[12px] text-danger">{displayError}</div>
          : needsRepository ? <div className="flex max-w-md flex-col items-center gap-3">
            <div className="text-[12px] text-subtle">This folder is not a Git repository.</div>
            {initError && <div role="alert" className="whitespace-pre-wrap break-words text-[12px] text-danger">{initError}</div>}
            <Button size="sm" disabled={initializing} onClick={() => void initialize()}>{initializing ? <><Spinner size={12} /> Initializing…</> : 'Initialize Repository'}</Button>
          </div>
          : loading ? <Spinner className="text-subtle" />
          : noCommits ? <div className="text-[12px] text-subtle">No commits yet.</div>
          : displayedDiffs.length ? displayedDiffs.map((diff) => <div key={diff.path} className="mb-3 overflow-clip rounded-lg border border-line">
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-bg px-3 py-2 text-[12px]">
                <button type="button" onClick={() => useStore.getState().openFile(diff.path)} className="min-w-0 flex-1 truncate text-left hover:text-link" title={diff.path}>{relativeTo(tab.cwd, diff.path, '')}</button>
                {diff.created && <span className="text-[11px] text-ok">new</span>}
                {diff.deleted && <span className="text-[11px] text-danger">deleted</span>}
                <DiffStat added={diff.added} removed={diff.removed} />
              </div>
              <DiffView diff={diff} maxHeight={null} />
            </div>) : <div className="text-[12px] text-subtle">{lastTurn ? 'No file changes in the last turn.' : 'No changes in this view.'}</div>}
      </div>
    </div>
  )
}

function TabFavicon({ src }: { src?: string }): ReactNode {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  return src && !failed ? <img src={src} alt="" draggable={false} onError={() => setFailed(true)} className="h-4 w-4 shrink-0 object-contain" /> : <Globe size={14} className="shrink-0" />
}

export function SidePanel({ root, covered }: { root: string | null; covered: boolean }): ReactNode {
  const tab = useStore((s) => s.panelTab)
  const tabs = useStore((s) => s.panelTabs)
  const browserStates = useStore((s) => s.browserStates)
  const openFiles = useStore((s) => s.openFiles)
  const closeTab = useStore((s) => s.closePanelTab)
  const createTab = useStore((s) => s.createPanelTab)
  const setPanel = useStore((s) => s.setPanel)
  const updateTab = useStore((s) => s.updatePanelTab)
  const moveTab = useStore((s) => s.movePanelTab)
  const duplicateTab = useStore((s) => s.duplicatePanelTab)
  const reloadTab = useStore((s) => s.reloadPanelTab)
  const chats = useStore((s) => s.chats)
  const strip = useRef<HTMLDivElement>(null)
  const contextAnchor = useRef<HTMLDivElement>(null)
  const [context, setContext] = useState<{ id: string; x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  useEffect(() => { if (covered) { setContext(null); setRenaming(null) } }, [covered])
  const activeTab = tabs.some((entry) => entry.id === tab) ? tab : undefined
  useEffect(() => {
    const browserTabs = tabs.filter((entry) => entry.type === 'browser')
    const titles = Object.fromEntries(browserTabs.filter((entry) => entry.customTitle).map((entry) => [entry.id, entry.customTitle!]))
    void window.galaxy.browser.setTabOrder(browserTabs.map((entry) => entry.id), titles).catch(() => {})
  }, [tabs])
  const icons = { browser: Globe, file: FileText, files: FolderOpen, terminal: SquareTerminal, review: GitCompare, agent: PanelRight, side: MessagesSquare }
  const contextTab = tabs.find((entry) => entry.id === context?.id)
  const titleFor = (entry: PanelTab): string => entry.customTitle ?? (entry.type === 'browser' ? browserStates[entry.id]?.title || (browserStates[entry.id]?.url ? browserStates[entry.id].url : 'New tab') : entry.type === 'side' && chats[entry.chatId] && chats[entry.chatId].title !== 'New chat' ? chats[entry.chatId].title : entry.title)
  const commitRename = (): void => { if (renaming && renameValue.trim()) updateTab(renaming, { customTitle: renameValue.trim() }); setRenaming(null) }
  const act = (action: () => void): void => { setContext(null); action() }
  useEffect(() => {
    const el = strip.current
    if (!el) return
    const wheel = (event: WheelEvent): void => {
      const amount = event.shiftKey ? event.deltaX || event.deltaY : event.deltaX
      if (!amount) return
      event.preventDefault()
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? el.clientWidth : 1
      el.scrollLeft += amount * scale
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])
  useLayoutEffect(() => {
    const el = strip.current
    const selected = el ? [...el.children].find((node) => (node as HTMLElement).dataset.tabId === activeTab) as HTMLElement | undefined : undefined
    if (!el || !selected) return
    if (selected.offsetLeft < el.scrollLeft) el.scrollLeft = selected.offsetLeft
    else if (selected.offsetLeft + selected.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = selected.offsetLeft + selected.offsetWidth - el.clientWidth
  }, [activeTab, tabs.length])

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      <div className="relative flex h-[46px] shrink-0 items-center gap-1.5 bg-bg px-2">
        <div ref={strip} className="panel-tab-strip no-drag relative flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1.5 px-px" style={{ maxWidth: tabs.reduce((width, tab) => width + (tab.pinned ? 58 : 224), 0) }}>
          {tabs.map((entry) => {
            const Icon = icons[entry.type]
            const title = titleFor(entry)
            const active = activeTab === entry.id
            return (
            <div
              key={entry.id}
              data-tab-id={entry.id}
              onContextMenu={(event) => { event.preventDefault(); setContext({ id: entry.id, x: event.clientX, y: event.clientY }) }}
              className={cn('tab-enter group/tab flex h-8 items-center rounded-xl border px-2.5 text-[12px] transition-all', active ? 'relative border-line bg-elev text-fg shadow-[0_2px_6px_rgba(0,0,0,0.08)]' : 'border-transparent text-muted hover:bg-hover hover:text-fg')}
              style={entry.pinned ? { flex: '0 0 54px', width: 54 } : { flex: '1 1 200px', minWidth: 105, maxWidth: 220 }}
            >
              {renaming === entry.id ? <input autoFocus value={renameValue} aria-label="Tab name" onChange={(event) => setRenameValue(event.target.value)} onBlur={commitRename} onKeyDown={(event) => { if (event.key === 'Enter') commitRename(); if (event.key === 'Escape') setRenaming(null) }} className="min-w-0 flex-1 rounded border border-line-strong bg-elev px-1 text-[12px] text-fg" /> : <button type="button" onClick={() => setPanel(true, entry.id)} className="flex h-full min-w-0 flex-1 items-center gap-2" title={title}>
                {entry.type === 'browser' ? <TabFavicon src={browserStates[entry.id]?.favicon} /> : <Icon size={14} className="shrink-0" />}
                {!entry.pinned && <span className="min-w-0 truncate">{title}</span>}
              </button>}
              <button
                type="button"
                title="Close tab"
                aria-label={`Close ${title}`}
                onClick={() => closeTab(entry.id)}
                className={cn('ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-opacity group-hover/tab:opacity-100', active ? 'text-muted opacity-100 hover:bg-active hover:text-fg' : 'text-subtle opacity-0 hover:bg-hover hover:text-fg')}
              >
                <X size={11} />
              </button>
            </div>
          )})}
        </div>
        <button type="button" aria-label="New tab" title="New tab" onClick={() => void createTab('browser', root)} className="no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"><Plus size={15} /></button>
        <div className="ml-auto"><IconButton label="Close panel" onClick={() => setPanel(false)}>
          <X size={15} />
        </IconButton></div>
        <div ref={contextAnchor} className="no-drag pointer-events-none fixed h-px w-px" style={{ left: context?.x ?? 0, top: context?.y ?? 0 }} />
        <Popover open={!!contextTab} onClose={() => setContext(null)} anchor={contextAnchor} placement="bottom-start" offset={0} className="w-60">
          {contextTab && <>
            <MenuItem icon={<Pin size={14} />} label={contextTab.pinned ? 'Unpin tab' : 'Pin tab'} onClick={() => act(() => updateTab(contextTab.id, { pinned: !contextTab.pinned }))} />
            <MenuSeparator />
            <MenuItem icon={<Plus size={14} />} label="New tab to the right" onClick={() => act(() => { void createTab('browser', root, undefined, contextTab.id) })} />
            <MenuItem icon={<RotateCw size={14} />} label="Reload" disabled={contextTab.type === 'terminal'} onClick={() => act(() => { void reloadTab(contextTab.id).catch((error) => useStore.getState().notify(String(error), 'error')) })} />
            <MenuItem icon={<Copy size={14} />} label="Duplicate" disabled={contextTab.type === 'side'} onClick={() => act(() => { void duplicateTab(contextTab.id) })} />
            <MenuSeparator />
            <MenuItem icon={<Pencil size={14} />} label="Rename" onClick={() => act(() => { setPanel(true, contextTab.id); setRenameValue(titleFor(contextTab)); setRenaming(contextTab.id) })} />
            <MenuSeparator />
            <MenuItem icon={<ArrowLeft size={14} />} label="Move left" disabled={tabs.findIndex((tab) => tab.id === contextTab.id) === 0} onClick={() => act(() => moveTab(contextTab.id, -1))} />
            <MenuItem icon={<ArrowRight size={14} />} label="Move right" disabled={tabs.findIndex((tab) => tab.id === contextTab.id) === tabs.length - 1} onClick={() => act(() => moveTab(contextTab.id, 1))} />
            <MenuSeparator />
            <MenuItem icon={<X size={14} />} label="Close tab" onClick={() => act(() => closeTab(contextTab.id))} />
            <MenuItem icon={<X size={14} />} label="Close other tabs" disabled={tabs.length < 2} onClick={() => act(() => { for (const tab of tabs) if (tab.id !== contextTab.id && !tab.pinned) closeTab(tab.id) })} />
            <MenuItem icon={<X size={14} />} label="Close tabs to the right" disabled={tabs.findIndex((tab) => tab.id === contextTab.id) === tabs.length - 1} onClick={() => act(() => { for (const tab of tabs.slice(tabs.findIndex((tab) => tab.id === contextTab.id) + 1)) if (!tab.pinned) closeTab(tab.id) })} />
          </>}
        </Popover>
      </div>
      <div className="chat-surface min-h-0 flex-1">
        {tabs.map((entry) => {
          if (entry.type === 'browser') return <BrowserPane key={entry.id} tabId={entry.id} root={root} visible={activeTab === entry.id && !covered && !contextTab} />
          if (entry.type === 'files') return <div key={entry.id} className={cn('h-full', activeTab !== entry.id && 'hidden')}><ProjectFilesPane tab={entry} available={!!root} renderFile={(file) => <FilePane file={file} visible={activeTab === entry.id} root={entry.root} />} /></div>
          if (entry.type === 'file') { const file = openFiles.find((file) => file.path === entry.path); return file ? <FilePane key={entry.id} file={file} visible={activeTab === entry.id} root={root} /> : null }
          return <div key={entry.id} className={cn('h-full', activeTab !== entry.id && 'hidden')}>
            {entry.type === 'side' ? <SideChatPane tab={entry} /> : entry.type === 'terminal' ? <TerminalPane tab={entry} visible={activeTab === entry.id} /> : entry.type === 'review' ? <ReviewPane tab={entry} visible={activeTab === entry.id} /> : <AgentTimeline chatId={entry.chatId} agentId={entry.agentId} root={entry.root} />}
          </div>
        })}
        {!activeTab && <Placeholder icon={<Plus size={22} />} title="Open a tab" detail="Select a tab above, or use + to open a new tab." />}
      </div>
      <CloseSideChatDialog />
    </div>
  )
}
