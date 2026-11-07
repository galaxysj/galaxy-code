import { artifactTitle, isDocumentArtifact, isScreenshotArtifact, isTasksArtifact, parseFrontMatter, parseTaskMarkdown, userEditable } from '@shared/artifacts'
import { TaskMark } from './TaskMark'
import hljs from 'highlight.js/lib/common'
import { unavailableAccounts } from '@shared/catalog'
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
  Camera,
  File as FileIcon,
  FileText,
  FolderOpen,
  Globe,
  Hammer,
  ListTodo,
  MessageSquareDiff,
  MessageSquarePlus,
  MessagesSquare,
  GitBranch,
  GitCompare,
  GitMerge,
  GitPullRequestArrow,
  CloudUpload,
  Download,
  GitCommitHorizontal,
  Plus,
  PanelRight,
  SquareCheck,
  SquareDashed,
  SquareTerminal,
  RotateCw,
  Scaling,
  X
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { FileView, FileDiff } from '@shared/types'
import type { ReviewCommit } from '@shared/api'
import { isReviewTextDiff } from '@shared/review'
import { basename, cn, formatBytes, languageForPath, plural, relativeTo } from '../lib/utils'
import { useStore, type OpenFile, type PanelTab } from '../store'
import { LiveMarkdown } from './LiveMarkdown'
import { Markdown } from './Markdown'
import { Button, CopyButton, Dropdown, IconButton, MenuItem, MenuSeparator, Popover, Segmented, Spinner, TabFavicon, usePopoverShown, type DropdownOption } from './ui'
import { DiffView, DiffStat } from './DiffView'
import { AgentTimeline } from './timeline/Timeline'
import { ProjectFilesPane } from './ProjectFiles'
import { CodeEditor, InlineEditBox } from './CodeEditor'
import { InlineModel, usableUtilityModels } from '@shared/models'
import { CloseSideChatDialog, SideChatPane } from './SideChat'
import { cleanError } from './Settings'
import { addComment } from '../lib/comments'
import { CommentBox, CommentableImage, CommentFloat, SelectionComment, type SelectionPoint } from './CommentBox'
import { isInstant, runGitCommand } from '../lib/gitCommands'
import type { BrowserPick, GitCommand, WorktreeMergeStrategy, WorktreeStatus } from '@shared/types'

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
  // Comment mode: the user marks something on the page; the note is written over a still of the page.
  const [commenting, setCommenting] = useState(false)
  const [sending, setSending] = useState<{ x: number; y: number } | null>(null)
  const pendingComments = useStore((s) => s.composerComments[s.activeChatId ?? 'new']?.length ?? 0)
  const [picked, setPicked] = useState<{ pick: BrowserPick; frame: string } | null>(null)
  const stepAside = (covered && !!frame) || !!picked
  // Responsive mode, as in Chrome's device toolbar: the page lays out at this size, scaled to fit, and its edges drag.
  const [responsive, setResponsive] = useState<{ width: number; height: number } | null>(null)
  const stage = useRef<HTMLDivElement>(null)
  const [space, setSpace] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const measure = (): void => setSpace({ width: el.clientWidth, height: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const scale = responsive && space.width > 0 ? Math.min(1, (space.width - RESPONSIVE_MARGIN * 2) / responsive.width, (space.height - RESPONSIVE_MARGIN * 2) / responsive.height) : 1
  const responsiveKey = responsive ? `${responsive.width}x${responsive.height}` : ''
  // A size the agent sets turns responsive mode on too, so the page always shows whole and the glow and cursor sit on it.
  const agentSize = state.pageSize ? `${state.pageSize.width}x${state.pageSize.height}` : ''
  useEffect(() => {
    if (!dragging.current && agentSize !== responsiveKey) setResponsive(state.pageSize ?? null)
  // Only a change from the browser side should move the toolbar.
  }, [agentSize])
  useEffect(() => {
    if (!hasPage) return
    void window.galaxy.browser.resize(responsive?.width ?? null, responsive?.height ?? null, tabId)
  }, [responsiveKey, hasPage, tabId])
  const dragging = useRef(false)
  const dragEdge = (edge: 'right' | 'bottom' | 'corner') => (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!responsive) return
    dragging.current = true
    event.preventDefault()
    const start = { x: event.clientX, y: event.clientY, ...responsive, scale }
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent): void => {
      // The page is centered, so a side edge moves half as far as the width changes.
      const width = edge === 'bottom' ? start.width : Math.round(start.width + ((next.clientX - start.x) * 2) / start.scale)
      const height = edge === 'right' ? start.height : Math.round(start.height + (next.clientY - start.y) / start.scale)
      setResponsive({ width: Math.max(200, Math.min(3840, width)), height: Math.max(200, Math.min(2400, height)) })
    }
    const end = (): void => {
      // Sizes still on their way back from the drag must not pull the toolbar back.
      window.setTimeout(() => { dragging.current = false }, 300)
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

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

  const toggleComment = (): void => {
    if (commenting) {
      void window.galaxy.browser.cancelPick(tabId)
      return
    }
    setCommenting(true)
    void window.galaxy.browser.pick(tabId).then(async (pick) => {
      setCommenting(false)
      if (!pick) return
      const image = await window.galaxy.browser.frame(tabId)
      if (image) setPicked({ pick, frame: image })
    }).catch(() => setCommenting(false))
  }
  useEffect(() => () => void window.galaxy.browser.cancelPick(tabId), [tabId])
  useEffect(() => { if (!visible && commenting) void window.galaxy.browser.cancelPick(tabId) }, [visible, commenting, tabId])

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
        <IconButton label={commenting ? 'Cancel commenting' : 'Comment on the page: click an element or drag an area'} active={commenting} disabled={!hasPage} onClick={toggleComment}>
          <MessageSquarePlus size={14} />
        </IconButton>
        {pendingComments > 0 && (
          <Button size="sm" title="Write the message and send it with your comments" onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); setSending((current) => current ? null : { x: box.right - 300, y: box.bottom + 6 }) }}>
            Comment
          </Button>
        )}
        {sending && <CommentBox send x={sending.x} y={sending.y} title="Message" onClose={() => setSending(null)} onSubmit={(note) => { const state = useStore.getState(); const key = state.activeChatId ?? 'new'; const current = state.composerText[key] ?? ''; state.setComposerText(key, current ? `${current.replace(/\s+$/, '')}\n${note.trim()}` : note.trim()) }} />}
        <IconButton label={responsive ? 'Exit responsive mode' : 'Responsive mode: drag the page edges to resize it'} active={!!responsive} disabled={!hasPage} onClick={() => setResponsive(responsive ? null : { width: 390, height: 844 })}>
          <Scaling size={13.5} />
        </IconButton>
        <IconButton label="Open in default browser" disabled={!/^https?:/.test(state.url)} onClick={() => void window.galaxy.files.openExternal(state.url)}>
          <ExternalLink size={13.5} />
        </IconButton>
      </div>
      {responsive && (
        <div className="flex h-8 shrink-0 items-center justify-center gap-1.5 border-b border-line text-[11.5px] text-muted">
          <Dropdown<string>
            label="Device size"
            value={RESPONSIVE_SIZES.find((size) => size.width === responsive.width && size.height === responsive.height)?.label ?? 'Custom'}
            options={[...RESPONSIVE_SIZES.map((size) => ({ value: size.label, label: size.label, hint: `${size.width}×${size.height}` })), { value: 'Custom', label: 'Custom' }]}
            onChange={(value) => { const size = RESPONSIVE_SIZES.find((entry) => entry.label === value); if (size) setResponsive({ width: size.width, height: size.height }) }}
          />
          <SizeInput value={responsive.width} onChange={(width) => setResponsive({ ...responsive, width })} label="Width" />
          <span>×</span>
          <SizeInput value={responsive.height} onChange={(height) => setResponsive({ ...responsive, height })} label="Height" />
          <span className="tabular-nums text-subtle">{Math.round(scale * 100)}%</span>
        </div>
      )}
      <div ref={stage} className={cn('relative min-h-0 flex-1', responsive && 'flex items-center justify-center bg-inset')}>
        <div ref={host} className={cn('overflow-hidden', !responsive && 'h-full w-full')} style={responsive ? { width: Math.round(responsive.width * scale), height: Math.round(responsive.height * scale) } : undefined}>
          {(picked?.frame ?? frame) && hasPage && <img src={picked?.frame ?? frame ?? ''} alt="" draggable={false} className="h-full w-full" />}
          {picked && (
            <div
              className="pointer-events-none absolute border-2 border-[#ff3b30] bg-[#ff3b30]/10"
              style={{ left: `${(picked.pick.rect.x / picked.pick.viewport.width) * 100}%`, top: `${(picked.pick.rect.y / picked.pick.viewport.height) * 100}%`, width: `${(picked.pick.rect.width / picked.pick.viewport.width) * 100}%`, height: `${(picked.pick.rect.height / picked.pick.viewport.height) * 100}%` }}
            />
          )}
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
        {picked && <BrowserComment picked={picked} host={host} onClose={() => setPicked(null)} />}
        {responsive && (
          <div className="pointer-events-none absolute" style={{ width: Math.round(responsive.width * scale) + 2 * RESPONSIVE_HANDLE, height: Math.round(responsive.height * scale) + 2 * RESPONSIVE_HANDLE }}>
            <div onPointerDown={dragEdge('right')} title="Drag to change the width" className="pointer-events-auto absolute right-0 top-1/2 flex h-10 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded bg-line-strong hover:bg-fg/40" style={{ width: RESPONSIVE_HANDLE - 4 }} />
            <div onPointerDown={dragEdge('bottom')} title="Drag to change the height" className="pointer-events-auto absolute bottom-0 left-1/2 w-10 -translate-x-1/2 cursor-ns-resize rounded bg-line-strong hover:bg-fg/40" style={{ height: RESPONSIVE_HANDLE - 4 }} />
            <div onPointerDown={dragEdge('corner')} title="Drag to resize" className="pointer-events-auto absolute bottom-0 right-0 cursor-nwse-resize rounded bg-line-strong hover:bg-fg/40" style={{ width: RESPONSIVE_HANDLE - 4, height: RESPONSIVE_HANDLE - 4 }} />
          </div>
        )}
      </div>
    </div>
  )
}

/** The note box for a marked element or area of a page, with the page's picture outlined as the attachment. */
function BrowserComment({ picked, host, onClose }: { picked: { pick: BrowserPick; frame: string }; host: RefObject<HTMLDivElement | null>; onClose(): void }): ReactNode {
  const { pick, frame } = picked
  const box = host.current?.getBoundingClientRect()
  const x = (box?.left ?? 0) + (pick.rect.x / pick.viewport.width) * (box?.width ?? 0)
  const y = (box?.top ?? 0) + ((pick.rect.y + pick.rect.height) / pick.viewport.height) * (box?.height ?? 0) + 6
  const element = pick.element
  return (
    <CommentBox
      x={x}
      y={y}
      title={element ? `<${element.tag}> ${element.selector.split(' > ').pop()}` : 'Selected area'}
      onClose={onClose}
      onSubmit={(note) => {
        const detail = [pick.url, pick.kind === 'element' ? 'element' : 'dragged area', element ? `selector ${element.selector}` : '', `x ${Math.round(pick.rect.x)}, y ${Math.round(pick.rect.y)}, ${Math.round(pick.rect.width)}x${Math.round(pick.rect.height)} px of the ${pick.viewport.width}x${pick.viewport.height} viewport`].filter(Boolean).join('; ')
        addComment({ source: pick.title || 'browser page', detail, quote: element?.text || element?.html, note, area: { group: `${pick.url}:${frame.length}:${frame.slice(-64)}`, src: frame, rect: pick.rect, reference: pick.viewport } })
      }}
    />
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

/** The plan written in Plan mode is plan.md in the chat's artifacts folder. */
const PLAN_FILE = /[/\\]\.galaxy[/\\][^/\\]+[/\\]artifacts[/\\]plan\.md$/i

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
  const [codeSelection, setCodeSelection] = useState<SelectionPoint | null>(null)

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
  /** A file in the chat's artifacts folder: shown by its name, with its own set of buttons. */
  const artifact = !!artifactTitle(file.path)
  const [commenting, setCommenting] = useState<{ x: number; y: number } | null>(null)
  const [sending, setSending] = useState<{ x: number; y: number } | null>(null)
  const isHtml = /\.html?$/i.test(file.path)
  const isSvg = view?.mime === 'image/svg+xml'
  /** A background process's output: shown read-only and kept current while it runs. */
  const processLog = /[/\\]galaxy-code[/\\]bg-[^/\\]+\.log$/.test(file.path)
  useEffect(() => {
    if (!processLog) return
    const timer = window.setInterval(() => setReload((n) => n + 1), 1500)
    return () => window.clearInterval(timer)
  }, [processLog])
  /** The agent's task list: shown as it is, never editable here. */
  const tasksFile = isTasksArtifact(file.path)
  /** A document the agent wrote: its front matter is hidden, and `user-editable: false` makes it read-only. */
  const document = isDocumentArtifact(file.path) && view?.kind === 'text'
  const front = document ? parseFrontMatter(view?.content ?? '') : null
  const locked = document && !userEditable(view?.content ?? '')
  const hasPreview = (isMarkdown || isSvg) && !tasksFile && !locked
  // The document's name is its tab title.
  useEffect(() => {
    const name = front?.meta.name
    if (document && name) useStore.getState().updatePanelTab(file.path, { customTitle: name })
  }, [document, front?.meta.name, file.path])

  return (
    <div className={cn('flex h-full flex-col', !visible && 'hidden')}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line pl-3 pr-2">
        {artifact ? (
          <span className="min-w-0 truncate text-[12.5px] font-medium text-fg">{front?.meta.name || artifactTitle(file.path)}</span>
        ) : (
          <span className="min-w-0 truncate font-mono text-[11.5px] text-muted" title={file.path}>
            {relativeTo(root, file.path, homeDir)}
          </span>
        )}
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
        {artifact ? (
          <>
            <IconButton label="Save a copy" size="sm" onClick={() => void window.galaxy.files.saveCopy(file.path, basename(file.path)).then((saved) => { if (saved) useStore.getState().notify(`Saved a copy to ${saved}`, 'info') }).catch((error: unknown) => useStore.getState().notify(String(error), 'error'))}>
              <Download size={13} />
            </IconButton>
            <IconButton label="Comment: add a note to send with your next message" size="sm" active={!!commenting} onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); setCommenting((current) => current ? null : { x: box.right - 300, y: box.bottom + 6 }) }}>
              <MessageSquarePlus size={13} />
            </IconButton>
          </>
        ) : (
          <>
            <IconButton label="Show in folder" size="sm" onClick={() => void window.galaxy.files.reveal(file.path)}>
              <FolderOpen size={13} />
            </IconButton>
            <IconButton label="Open with default app" size="sm" onClick={() => void window.galaxy.files.openExternal(file.path)}>
              <ExternalLink size={13} />
            </IconButton>
          </>
        )}
        {artifact && (
          <Button size="sm" className="ml-0.5" title="Write the message and send it with your comments" onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); setSending((current) => current ? null : { x: box.right - 300, y: box.bottom + 6 }) }}>
            Comment
          </Button>
        )}
        {sending && <CommentBox send x={sending.x} y={sending.y} title="Message" onClose={() => setSending(null)} onSubmit={(note) => { const state = useStore.getState(); const key = state.activeChatId ?? 'new'; const current = state.composerText[key] ?? ''; state.setComposerText(key, current ? `${current.replace(/\s+$/, '')}\n${note.trim()}` : note.trim()) }} />}
        {commenting && <CommentBox x={commenting.x} y={commenting.y} title={`Comment on ${front?.meta.name || artifactTitle(file.path)}`} onClose={() => setCommenting(null)} onSubmit={(note) => addComment({ source: front?.meta.name || artifactTitle(file.path) || basename(file.path), note })} />}
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
            <CommentableImage src={view.dataUrl ?? ''} source={artifactTitle(file.path) ?? view.name} alt={view.name} className="rounded shadow-pop" />
          </div>
        ) : tasksFile && view.kind === 'text' ? (
          <SelectionComment source={artifactTitle(file.path) ?? basename(file.path)} content={view.content} className="h-full overflow-y-auto px-6 py-5">
            <div className="space-y-2">
              {parseTaskMarkdown(view.content ?? '').map((task, index) => (
                <div key={index} className="flex items-start gap-2.5 text-[13.5px] leading-[1.5]" style={{ paddingLeft: (task.depth ?? 0) * 20 }}>
                  <TaskMark status={task.status} className="mt-[3px]" />
                  <span className={cn('selectable min-w-0', task.status === 'completed' ? 'text-subtle line-through decoration-line-strong' : task.status === 'in_progress' ? 'font-medium text-fg' : 'text-muted')}>{task.content}</span>
                </div>
              ))}
            </div>
          </SelectionComment>
        ) : document && locked ? (
          <SelectionComment source={front?.meta.name || basename(file.path)} content={front?.body} className="h-full overflow-y-auto px-6 py-5">
            <Markdown text={front?.body ?? ''} root={file.path.slice(0, file.path.lastIndexOf('/'))} html />
          </SelectionComment>
        ) : isMarkdown && mode === 'preview' && view.kind === 'text' && !view.truncated ? (
          <SelectionComment source={front?.meta.name || artifactTitle(file.path) || basename(file.path)} content={front ? front.body : view.content ?? ''} className="flex h-full flex-col">
            <LiveMarkdown key={`${file.path}:${file.nonce}:${reload}:${editStamp}`} initial={front ? front.body : view.content ?? ''} onChange={(text) => editLive((front?.raw ?? '') + text)} onSave={(text) => saveLive((front?.raw ?? '') + text)} />
          </SelectionComment>
        ) : isMarkdown && mode === 'preview' ? (
          <SelectionComment source={artifactTitle(file.path) || basename(file.path)} content={view.content} className="h-full overflow-y-auto px-6 py-5">
            <Markdown text={view.content ?? ''} root={file.path.slice(0, file.path.lastIndexOf('/'))} html />
          </SelectionComment>
        ) : processLog && view.kind === 'text' ? (
          <SelectionComment source={relativeTo(root, file.path, homeDir)} content={view.content} className="h-full"><SourceView content={view.content ?? ''} path={file.path} line={file.line} /></SelectionComment>
        ) : view.kind === 'text' && !view.truncated ? (
          <CodeEditor onSelect={(selection) => setCodeSelection(selection)} path={file.path} initial={view.content ?? ''} line={file.line} onDirtyChange={isMarkdown ? undefined : setDirty} onTextChange={isMarkdown ? editLive : undefined} onSaved={isMarkdown ? savedLive : undefined} onCompletingChange={setCompleting} />
        ) : (
          <SelectionComment source={relativeTo(root, file.path, homeDir)} content={view.content} className="h-full"><SourceView content={view.content ?? ''} path={file.path} line={file.line} /></SelectionComment>
        )}
        {codeSelection && <CommentFloat key={`${codeSelection.x}:${codeSelection.y}:${codeSelection.quote.length}`} point={codeSelection} source={relativeTo(root, file.path, homeDir)} onClose={() => setCodeSelection(null)} />}
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
  const removedAccounts = useStore((s) => s.settings.removedAccounts)
  const acpEnabled = useStore((s) => s.settings.acpEnabled)
  const modelId = usableUtilityModels(InlineModel, accounts, unavailableAccounts({ acpEnabled, removedAccounts })).some((m) => m.ID === inlineModelId) ? (inlineModelId as string) : InlineModel[0].ID

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
      setAsk((current) => (current ? { ...current, busy: false, error: String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') } : current))
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

type ReviewMode = 'last-turn' | 'branch' | 'uncommitted' | 'unstaged' | 'staged' | 'commit'

const REVIEW_MODES: DropdownOption<ReviewMode>[] = [
  { value: 'last-turn', label: 'Last turn', icon: <MessageSquareDiff size={13.5} /> },
  { value: 'uncommitted', label: 'Uncommitted', icon: <FileDiffIcon size={13.5} /> },
  { value: 'unstaged', label: 'Unstaged', icon: <SquareDashed size={13.5} /> },
  { value: 'staged', label: 'Staged', icon: <SquareCheck size={13.5} /> },
  { value: 'commit', label: 'Commit…', icon: <GitCommitHorizontal size={13.5} /> }
]

/** A worktree chat's branch against its base: where it stands, and the actions that land it. */
function WorktreeBar({ chatId, status, running, onChanged }: { chatId: string; status: WorktreeStatus; running: boolean; onChanged(): void }): ReactNode {
  const [busy, setBusy] = useState<WorktreeMergeStrategy | 'update' | null>(null)
  const [menu, setMenu] = useState(false)
  const [conflicts, setConflicts] = useState<string[]>([])
  const anchor = useRef<HTMLDivElement>(null)
  const { branch, baseBranch: base, ahead, behind, dirty, projectBranch } = status
  const run = async (action: WorktreeMergeStrategy | 'update'): Promise<void> => {
    setBusy(action)
    setConflicts([])
    const { notify } = useStore.getState()
    try {
      const result = action === 'update' ? await window.galaxy.worktree.update(chatId) : await window.galaxy.worktree.merge(chatId, action)
      if (result.merged) notify(action === 'update' ? `Updated from ${base}` : `Merged into ${base} (${result.hash})`, 'info')
      else setConflicts(result.conflicts)
      onChanged()
    } catch (error) {
      notify(cleanError(error), 'error')
      onChanged()
    } finally {
      setBusy(null)
    }
  }
  const askAgent = (): void => {
    const files = conflicts.join(', ')
    setConflicts([])
    void useStore.getState().send(`Merge ${base} into this branch and resolve the conflicts in ${files}. Commit the result.`, [], undefined, false, undefined, undefined, chatId)
  }
  const blocked = !base
    ? 'This worktree has no base branch.'
    : running ? 'Wait for the chat to finish.'
    : projectBranch !== base ? `The project folder is on ${projectBranch ?? 'a detached HEAD'}. Switch it to ${base} to merge.`
    : !ahead && !dirty ? `Nothing to merge into ${base}.`
    : undefined
  const facts = [ahead ? `${plural(ahead, 'commit')} ahead` : '', behind ? `${behind} behind` : '', dirty ? 'uncommitted changes' : ''].filter(Boolean)
  return (
    <div className="shrink-0 border-b border-line px-3 py-1.5 text-[12px]">
      <div className="flex min-h-7 items-center gap-2">
        <GitBranch size={13} className="shrink-0 text-subtle" />
        <span className="min-w-0 flex-1 truncate text-muted" title={`${branch} → ${base ?? '?'}`}>
          {branch} → {base ?? '?'}{facts.length ? ` · ${facts.join(' · ')}` : ' · up to date'}
        </span>
        {behind > 0 && (
          <Button size="sm" disabled={busy !== null || running} title={`Bring ${base}'s new commits into this branch.`} onClick={() => void run('update')}>
            {busy === 'update' ? <Spinner size={12} /> : <GitPullRequestArrow size={13} />} Update
          </Button>
        )}
        <div ref={anchor} className="flex shrink-0 items-center">
          <Button size="sm" variant="primary" disabled={busy !== null || !!blocked} title={blocked ?? `Merge ${branch} into ${base}, committing uncommitted changes first.`} onClick={() => void run('merge')} className="rounded-r-none">
            {busy === 'merge' || busy === 'squash' ? <Spinner size={12} /> : <GitMerge size={13} />} Merge
          </Button>
          <Button size="sm" variant="primary" aria-label="More merge actions" disabled={busy !== null || !!blocked} onClick={() => setMenu((open) => !open)} className="w-4 rounded-l-none border-l border-white/20 px-0!">
            <ChevronDown size={12} />
          </Button>
          <Popover open={menu} onClose={() => setMenu(false)} anchor={anchor} placement="bottom-end" className="w-48 p-1">
            <MenuItem icon={<GitMerge size={13} />} label="Squash and merge" onClick={() => { setMenu(false); void run('squash') }} />
          </Popover>
        </div>
      </div>
      {conflicts.length > 0 && (
        <div role="alert" className="mt-1.5 flex items-start gap-2 rounded-lg bg-inset px-2.5 py-2">
          <div className="min-w-0 flex-1 text-muted">
            <div>This conflicts with {base}, so nothing was changed.</div>
            <div className="mt-0.5 break-all font-mono text-[11.5px] text-subtle">{conflicts.join(', ')}</div>
          </div>
          <Button size="sm" disabled={running} onClick={askAgent}>Ask the agent to resolve</Button>
        </div>
      )}
    </div>
  )
}

function ReviewPane({ tab, visible }: { tab: WorkspaceTab; visible: boolean }): ReactNode {
  const chatId = useStore((s) => tab.chatId ?? s.activeChatId)
  const items = useStore((s) => chatId ? s.items[chatId] : undefined)
  const chatStatus = useStore((s) => chatId ? s.chats[chatId]?.status : undefined)
  const worktree = useStore((s) => chatId ? s.chats[chatId]?.worktree ?? null : null)
  const [worktreeStatus, setWorktreeStatus] = useState<WorktreeStatus | null>(null)
  const [git, setGit] = useState<{ isRepo: boolean; dirty: boolean; hasRemote: boolean } | null>(null)
  const [gitMenu, setGitMenu] = useState(false)
  // An action picked from the menu takes the main button until it finishes.
  const [chosen, setChosen] = useState<'commit' | 'commit-push' | 'push' | null>(null)
  const [committing, setCommitting] = useState<GitCommand | null>(null)
  const commitStarted = useRef(false)
  const gitMenuAnchor = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<ReviewMode>(worktree?.baseBranch ? 'branch' : 'last-turn')
  const modes: DropdownOption<ReviewMode>[] = worktree?.baseBranch ? [{ value: 'branch', label: 'Branch', icon: <GitBranch size={13.5} />, title: `Everything this branch adds to ${worktree.baseBranch}` }, ...REVIEW_MODES] : REVIEW_MODES
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
  useEffect(() => {
    if (!visible || !chatId || !worktree) {
      setWorktreeStatus(null)
      return
    }
    let cancelled = false
    void window.galaxy.worktree.status(chatId).then((value) => { if (!cancelled) setWorktreeStatus(value) }).catch(() => { if (!cancelled) setWorktreeStatus(null) })
    return () => { cancelled = true }
  }, [chatId, worktree, visible, reload, tab.nonce, chatStatus])
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
    void window.galaxy.review.read(tab.cwd, { mode, ...(mode === 'commit' ? { commit } : {}), ...(mode === 'branch' ? { base: worktree?.baseBranch ?? '' } : {}) }).then((value) => {
      if (!cancelled) {
        setReview(value)
        setIsRepo(value.isRepo)
      }
    }).catch((error) => { if (!cancelled) setError(cleanError(error)) })
    return () => { cancelled = true }
  }, [tab.cwd, visible, reload, tab.nonce, mode, commit, worktree?.baseBranch])
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
        <Dropdown<ReviewMode> label="Review changes" value={mode} options={modes} onChange={setMode} className="shrink-0" />
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
      {worktreeStatus && chatId && <WorktreeBar chatId={chatId} status={worktreeStatus} running={chatStatus === 'running' || chatStatus === 'awaiting'} onChanged={() => setReload((value) => value + 1)} />}
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
                <button type="button" onClick={() => useStore.getState().openFile(diff.path)} className="min-w-0 flex-1 truncate text-left hover:text-link" title={artifactTitle(diff.path) ? undefined : diff.path}>{relativeTo(tab.cwd, diff.path, '')}</button>
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
  const titleFor = (entry: PanelTab): string => (entry.type === 'file' && (['Plan', 'Task'].includes(artifactTitle(entry.path) ?? '') || isScreenshotArtifact(entry.path)) ? artifactTitle(entry.path) : null) ?? entry.customTitle ?? (entry.type === 'browser' ? browserStates[entry.id]?.title || (browserStates[entry.id]?.url ? browserStates[entry.id].url : 'New tab') : entry.type === 'side' && chats[entry.chatId] && chats[entry.chatId].title !== 'New chat' ? chats[entry.chatId].title : entry.title)
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
            const Icon = entry.type === 'file' && /[/\\]galaxy-code[/\\]bg-[^/\\]+\.log$/.test(entry.path) ? SquareTerminal : entry.type === 'file' && artifactTitle(entry.path) ? (artifactTitle(entry.path) === 'Plan' ? FileText : artifactTitle(entry.path) === 'Task' ? ListTodo : isScreenshotArtifact(entry.path) ? Camera : FileIcon) : icons[entry.type]
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
        {/* In the body, since the transform of the sliding pane would make `fixed` count from the pane and not the window. */}
        {createPortal(<div ref={contextAnchor} className="no-drag pointer-events-none fixed h-px w-px" style={{ left: context?.x ?? 0, top: context?.y ?? 0 }} />, document.body)}
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


const RESPONSIVE_MARGIN = 16
const RESPONSIVE_HANDLE = 12
const RESPONSIVE_SIZES = [
  { label: 'Phone', width: 390, height: 844 },
  { label: 'Tablet', width: 768, height: 1024 },
  { label: 'Laptop', width: 1280, height: 800 },
  { label: 'Desktop', width: 1440, height: 900 }
]

/** A page dimension in the responsive toolbar; takes effect on Enter or when it loses focus. */
function SizeInput({ value, label, onChange }: { value: number; label: string; onChange(value: number): void }): ReactNode {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const next = Number.parseInt(draft, 10)
    if (Number.isFinite(next)) onChange(Math.max(200, Math.min(3840, next)))
    else setDraft(String(value))
  }
  return (
    <input
      aria-label={label}
      value={draft}
      onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, ''))}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
      className="h-6 w-14 rounded-md bg-inset px-1.5 text-center tabular-nums text-fg shadow-[0_0_0_1px_var(--border)]"
    />
  )
}
