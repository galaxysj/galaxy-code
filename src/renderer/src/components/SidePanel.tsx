import hljs from 'highlight.js/lib/common'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  Pin,
  Pencil,
  Code,
  ExternalLink,
  Eye,
  FileQuestion,
  FileText,
  FolderOpen,
  Globe,
  GitCompare,
  Plus,
  PanelRight,
  SquareTerminal,
  RotateCw,
  X
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { FileView, FileDiff } from '@shared/types'
import { basename, cn, formatBytes, languageForPath, relativeTo } from '../lib/utils'
import { useStore, type OpenFile, type PanelTab } from '../store'
import { Markdown } from './Markdown'
import { CopyButton, IconButton, MenuItem, MenuSeparator, Popover, Segmented, Spinner } from './ui'
import { DiffView, DiffStat } from './DiffView'
import { AgentTimeline } from './timeline/Timeline'
import { ProjectFilesPane } from './ProjectFiles'

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

  useEffect(() => {
    if (!editing) setAddress(state.url)
  }, [state.url, editing])

  // The page is a native view layered over the window; keep it glued to this placeholder.
  const sync = useCallback(() => {
    const el = host.current
    if (!el || !visible || !hasPage) {
      void window.galaxy.browser.setBounds(null, tabId)
      return
    }
    const rect = el.getBoundingClientRect()
    void window.galaxy.browser.setBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }, tabId)
  }, [visible, hasPage, tabId])

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
          {!hasPage && (
            <div className="flex h-full flex-col items-center justify-center gap-5 px-5 text-center">
              <div><div className="mb-2 text-[19px] font-medium text-fg">New tab</div><div className="text-[12px] text-subtle">Enter a website above, or open a tool.</div></div>
              <div className="grid w-full max-w-[360px] grid-cols-3 gap-2">
                {([{ type: 'file', label: 'Files', Icon: FolderOpen }, { type: 'terminal', label: 'Terminal', Icon: SquareTerminal }, { type: 'review', label: 'Review', Icon: GitCompare }] as const).map(({ type, label, Icon }) => <button key={type} type="button" disabled={type === 'file' && !root} title={type === 'file' && !root ? 'Select a project to browse files' : label} onClick={() => void createTab(type, root, tabId)} className="flex min-w-0 flex-col items-center gap-2 rounded-xl border border-line bg-elev px-2 py-4 text-[12px] text-muted transition-all hover:border-line-strong hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-40 disabled:hover:bg-elev"><Icon size={18} /><span>{label}</span></button>)}
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

function FilePane({ file, visible, root }: { file: OpenFile; visible: boolean; root: string | null }): ReactNode {
  const homeDir = useStore((s) => s.homeDir)
  const showBrowser = useStore((s) => s.showBrowser)
  const [view, setView] = useState<FileView | null>(null)
  const [mode, setMode] = useState<'preview' | 'source'>('preview')
  const [reload, setReload] = useState(0)

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

  useEffect(() => {
    let cancelled = false
    setView(null)
    void window.galaxy.files.read(file.path).then((result) => {
      if (!cancelled) setView(result)
    })
    return () => {
      cancelled = true
    }
  }, [file.path, file.nonce, reload, editStamp])

  const isMarkdown = /\.(md|mdx|markdown)$/i.test(file.path)
  const isHtml = /\.html?$/i.test(file.path)
  const isSvg = view?.mime === 'image/svg+xml'
  const hasPreview = isMarkdown || isSvg

  return (
    <div className={cn('flex h-full flex-col', !visible && 'hidden')}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line pl-3 pr-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted" title={file.path}>
          {relativeTo(root, file.path, homeDir)}
        </span>
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
        ) : isMarkdown && mode === 'preview' ? (
          <div className="h-full overflow-y-auto px-6 py-5">
            <Markdown text={view.content ?? ''} root={file.path.slice(0, file.path.lastIndexOf('/'))} />
          </div>
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
  useEffect(() => {
    if (!host.current) return
    const term = new Terminal({
      cursorBlink: true, fontSize: 12, fontFamily: 'Menlo, Monaco, monospace',
      scrollback: 10000, allowProposedApi: false
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
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
      term.dispose()
      terminal.current = null
      fitAddon.current = null
    }
  }, [tab.id, notify])
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
      <div ref={host} aria-label="Live terminal" className="min-h-0 flex-1 overflow-hidden p-3" />
    </div>
  )
}

function ReviewPane({ tab, visible }: { tab: WorkspaceTab; visible: boolean }): ReactNode {
  const items = useStore((s) => tab.chatId ? s.items[tab.chatId] : undefined)
  const [review, setReview] = useState<{ isRepo: boolean; patch: string; untracked: string[] } | null>(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const diffs = useMemo(() => {
    const files = new Map<string, FileDiff>()
    for (const item of items ?? []) if (item.kind === 'tool' && item.status === 'done') for (const diff of item.meta?.diffs ?? []) files.set(diff.path, diff)
    return [...files.values()]
  }, [items])
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    void window.galaxy.review.read(tab.cwd).then((value) => { if (!cancelled) { setReview(value); setError('') } }).catch((error) => { if (!cancelled) setError(String(error)) })
    return () => { cancelled = true }
  }, [tab.cwd, visible, reload, diffs, tab.nonce])
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3"><span className="min-w-0 flex-1 truncate text-[12px] text-muted" title={tab.cwd}>Changes</span><IconButton label="Refresh changes" onClick={() => setReload((value) => value + 1)}><RotateCw size={13} /></IconButton></div>
      <div className="selectable min-h-0 flex-1 overflow-auto px-4 py-3">
        {error ? <div className="text-[12px] text-danger">{error}</div> : !review ? <Spinner className="text-subtle" /> : review.isRepo ? <>
          {review.patch ? <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.6]">{review.patch}</pre> : <div className="text-[12px] text-subtle">No tracked changes.</div>}
          {review.untracked.length > 0 && <div className="mt-4"><div className="mb-2 text-[12px] text-muted">New files</div>{review.untracked.map((path) => <button key={path} type="button" onClick={() => useStore.getState().openFile(`${tab.cwd}/${path}`)} className="block text-left font-mono text-[11.5px] text-ok hover:underline">{path}</button>)}</div>}
        </> : diffs.length ? diffs.map((diff) => <div key={diff.path} className="mb-3 overflow-hidden rounded-lg border border-line"><div className="flex items-center gap-2 px-3 py-2 text-[12px]"><span className="min-w-0 flex-1 truncate">{basename(diff.path)}</span><DiffStat added={diff.added} removed={diff.removed} /></div><DiffView diff={diff} maxHeight={null} /></div>) : <div className="text-[12px] text-subtle">No recorded file changes.</div>}
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
  const icons = { browser: Globe, file: FileText, files: FolderOpen, terminal: SquareTerminal, review: GitCompare, agent: PanelRight }
  const contextTab = tabs.find((entry) => entry.id === context?.id)
  const titleFor = (entry: PanelTab): string => entry.customTitle ?? (entry.type === 'browser' ? browserStates[entry.id]?.title || (browserStates[entry.id]?.url ? browserStates[entry.id].url : 'New tab') : entry.title)
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
              className={cn('tab-enter group/tab flex h-8 items-center rounded-xl border px-2.5 text-[12px] transition-all', active ? 'relative border-black/6 bg-white text-[#25251f] shadow-[0_2px_6px_rgba(0,0,0,0.08)]' : 'border-transparent text-muted hover:bg-hover hover:text-fg')}
              style={entry.pinned ? { flex: '0 0 54px', width: 54 } : { flex: '1 1 200px', minWidth: 105, maxWidth: 220 }}
            >
              {renaming === entry.id ? <input autoFocus value={renameValue} aria-label="Tab name" onChange={(event) => setRenameValue(event.target.value)} onBlur={commitRename} onKeyDown={(event) => { if (event.key === 'Enter') commitRename(); if (event.key === 'Escape') setRenaming(null) }} className="min-w-0 flex-1 rounded border border-line-strong bg-white px-1 text-[12px] text-[#25251f]" /> : <button type="button" onClick={() => setPanel(true, entry.id)} className="flex h-full min-w-0 flex-1 items-center gap-2" title={title}>
                {entry.type === 'browser' ? <TabFavicon src={browserStates[entry.id]?.favicon} /> : <Icon size={14} className="shrink-0" />}
                {!entry.pinned && <span className="min-w-0 truncate">{title}</span>}
              </button>}
              <button
                type="button"
                title="Close tab"
                aria-label={`Close ${title}`}
                onClick={() => closeTab(entry.id)}
                className={cn('ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-opacity group-hover/tab:opacity-100', active ? 'text-[#777770] opacity-100 hover:bg-black/8 hover:text-black' : 'text-subtle opacity-0 hover:bg-hover hover:text-fg')}
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
            <MenuItem icon={<Copy size={14} />} label="Duplicate" onClick={() => act(() => { void duplicateTab(contextTab.id) })} />
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
            {entry.type === 'terminal' ? <TerminalPane tab={entry} visible={activeTab === entry.id} /> : entry.type === 'review' ? <ReviewPane tab={entry} visible={activeTab === entry.id} /> : <AgentTimeline chatId={entry.chatId} agentId={entry.agentId} root={entry.root} />}
          </div>
        })}
        {!activeTab && <Placeholder icon={<Plus size={22} />} title="Open a tab" detail="Select a tab above, or use + to open a new tab." />}
      </div>
    </div>
  )
}
