import {
  Bot,
  Brain,
  Check,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleDot,
  ExternalLink,
  File as FileIcon,
  FileImage,
  FilePen,
  FilePlus,
  FileText,
  FolderOpen,
  FolderTree,
  Globe,
  ImageIcon,
  Lightbulb,
  ListTodo,
  MessageCircle,
  MessageCircleQuestion,
  PanelRight,
  Plug,
  Search,
  SquareTerminal,
  Wrench
} from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { EXPLORE_KINDS, type AskQuestion, type Item, type ReasoningItem, type TaskEntry, type ToolItem, type ToolKind } from '@shared/types'
import { basename, cn, formatBytes, formatDuration, plural, relativeTo } from '../../lib/utils'
import { toolActivityTitle } from '../../lib/toolActivity'
import { useStore } from '../../store'
import { DiffStat, DiffView } from '../DiffView'
import { Markdown } from '../Markdown'
import { Button, Spinner } from '../ui'

export interface TimelineContext {
  chatId: string
  root: string | null
  children: Map<string, Item[]>
  agentNames: Map<string, string>
  /** Id of the newest task list, the only one drawn in full. */
  latestTaskId: string | null
  renderBlocks(items: Item[]): ReactNode
}

const KIND_ICON: Record<ToolKind, typeof Wrench> = {
  read: FileText,
  grep: Search,
  glob: Search,
  list: FolderTree,
  websearch: Globe,
  webfetch: Globe,
  bash: SquareTerminal,
  edit: FilePen,
  create: FilePlus,
  browser: Globe,
  mcp: Plug,
  agent: Bot,
  ask: MessageCircleQuestion,
  task: ListTodo,
  present: FileIcon,
  open: PanelRight,
  memory: Brain,
  image: ImageIcon,
  other: Wrench
}

function isLive(item: ToolItem): boolean {
  return item.status === 'running' || item.status === 'pending'
}

function StatusMark({ item }: { item: ToolItem }): ReactNode {
  if (item.tool === 'bash' && item.status === 'error') return null
  if (item.status === 'error') return <span className="shrink-0 text-[12.7px] text-danger">Failed</span>
  if (item.status === 'denied') return <span className="shrink-0 text-[12.7px] text-subtle">Declined</span>
  if (item.status === 'awaiting') return <span className="shrink-0 text-[12.7px] text-warn">Needs approval</span>
  return null
}

interface RowProps {
  icon: ReactNode
  title: ReactNode
  detail?: ReactNode
  trailing?: ReactNode
  live?: boolean
  open?: boolean
  onToggle?(): void
  dim?: boolean
}

/** One line of agent activity. Clicking it reveals the detail underneath. */
/** Emphasizes the leading verb of a plain-text title ("Explored 3 files"). */
function leadWord(title: ReactNode): ReactNode {
  if (typeof title !== 'string') return title
  const space = title.indexOf(' ')
  if (space <= 0) return title
  return <><span className="text-fg">{title.slice(0, space)}</span>{title.slice(space)}</>
}

function Row({ icon, title, detail, trailing, live, open, onToggle, dim }: RowProps): ReactNode {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={!onToggle}
      aria-expanded={onToggle ? open : undefined}
      className={cn(
        'group/row flex h-7 w-full min-w-0 items-center gap-2 rounded-md text-left text-[13.8px] transition-colors',
        onToggle ? 'hover:text-fg' : 'cursor-default',
        dim ? 'text-subtle' : 'text-muted'
      )}
    >
      <span className="flex w-4 shrink-0 justify-center">{live ? <Spinner size={13} /> : icon}</span>
      <span className={cn('min-w-0 shrink truncate', live && 'shimmer')}>{leadWord(title)}</span>
      {detail && <span className="min-w-0 flex-1 truncate font-mono text-[12.7px] text-subtle">{detail}</span>}
      {!detail && <span className="flex-1" />}
      {trailing}
      {onToggle && (
        <ChevronRight
          size={13}
          className={cn('shrink-0 text-subtle opacity-0 transition-all group-hover/row:opacity-100', open && 'rotate-90 opacity-100')}
        />
      )}
    </button>
  )
}

function Panel({ children, className }: { children: ReactNode; className?: string }): ReactNode {
  return <div className={cn('mb-1.5 ml-6 overflow-hidden rounded-lg border border-line bg-inset', className)}>{children}</div>
}

function OutputBlock({ text, follow, maxHeight = 300 }: { text: string; follow?: boolean; maxHeight?: number }): ReactNode {
  const ref = useRef<HTMLPreElement>(null)
  const following = useRef(true)
  useLayoutEffect(() => {
    if (follow && following.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [text, follow])
  return (
    <pre ref={ref} onScroll={(event) => {
      const el = event.currentTarget
      following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    }} className="selectable overflow-auto overscroll-contain whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12.7px] leading-[1.55] text-muted" style={{ maxHeight }}>
      {text}
    </pre>
  )
}

/** Activity changes reset expansion; grouped activity can preserve an explicit collapse. */
function useDisclosure(auto: boolean, activityKey?: string, preserveCollapse = false): [boolean, () => void] {
  const [manual, setManual] = useState<{ key?: string; open: boolean } | null>(null)
  const open = manual && (manual.key === activityKey || (preserveCollapse && !manual.open)) ? manual.open : auto
  return [open, () => setManual({ key: activityKey, open: !open })]
}

// Explore

function exploreSummary(items: ToolItem[], verb = 'Explored'): string {
  const files = items.filter((i) => i.tool === 'read' && !i.meta?.skill).length
  const skills = items.filter((i) => i.meta?.skill).length
  const searches = items.filter((i) => i.tool === 'grep' || i.tool === 'glob').length
  const lists = items.filter((i) => i.tool === 'list').length
  const web = items.filter((i) => i.tool === 'websearch').length
  const pages = items.filter((i) => i.tool === 'webfetch').length
  const parts = [
    files && plural(files, 'file'),
    skills && plural(skills, 'skill'),
    searches && plural(searches, 'search', 'searches'),
    lists && plural(lists, 'folder'),
    web && plural(web, 'web search', 'web searches'),
    pages && plural(pages, 'page')
  ].filter(Boolean)
  return `${verb} ${parts.join(', ')}`
}

function browsingPages(items: ToolItem[]): number {
  const urls = new Set<string>()
  for (const item of items) {
    if (item.status === 'denied' || item.status === 'error') continue
    const input = item.input as { url?: unknown } | null
    const url = item.output?.match(/^URL:\s*(\S+)/m)?.[1] ?? item.meta?.url ?? (typeof input?.url === 'string' ? input.url : null)
    if (!url || url === 'about:blank') continue
    try {
      const page = new URL(url)
      page.hash = ''
      urls.add(page.href)
    } catch { urls.add(url) }
  }
  return urls.size || (items.some((item) => item.status !== 'denied' && item.status !== 'error') ? 1 : 0)
}

function ExploreLine({ item }: { item: ToolItem }): ReactNode {
  const openFile = useStore((s) => s.openFile)
  const Icon = KIND_ICON[item.tool]
  const path = item.tool === 'read' && typeof (item.input as { path?: string; file_path?: string })?.path === 'string' ? (item.input as { path: string }).path : (item.input as { file_path?: string })?.file_path
  const url = item.meta?.url
  const results = item.meta?.results
  const [open, setOpen] = useState(false)
  const action = path ? () => openFile(path) : url ? () => void window.galaxy.files.openExternal(url) : results?.length ? () => setOpen(!open) : undefined
  return (
    <div>
      <button
        type="button"
        disabled={!action}
        onClick={action}
        className={cn('flex h-7 w-full min-w-0 items-center gap-2 text-left text-[13.8px] text-muted', action && 'hover:text-fg')}
      >
        <span className="flex w-4 shrink-0 justify-center">{isLive(item) ? <Spinner size={13} /> : <Icon size={13.5} className="text-subtle" />}</span>
        <span className={cn('min-w-0 truncate', isLive(item) && 'shimmer')}>{leadWord(toolActivityTitle(item))}</span>
        {item.detail && item.detail !== basename(item.detail) && <span className="min-w-0 flex-1 truncate font-mono text-[12.1px] text-subtle">{item.detail}</span>}
        {item.meta?.matches !== undefined && item.tool !== 'read' && <span className="shrink-0 text-[12.1px] text-subtle">{plural(item.meta.matches, 'match', 'matches')}</span>}
        <StatusMark item={item} />
      </button>
      {open && results && (
        <div className="mb-1 ml-3 space-y-1">
          {results.slice(0, 8).map((result) => (
            <button key={result.url} type="button" onClick={() => void window.galaxy.files.openExternal(result.url)} className="block w-full text-left hover:text-fg">
              <div className="truncate text-[13.2px] text-muted">{result.title}</div>
              <div className="truncate font-mono text-[11.6px] text-subtle">{result.url}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export const ExploreGroup = memo(function ExploreGroup({ items, disclosureKey, active = false, browsing = false, ctx }: { items: (ToolItem | ReasoningItem)[]; disclosureKey: string; active?: boolean; browsing?: boolean; ctx?: TimelineContext }): ReactNode {
  const tools = items.filter((item): item is ToolItem => item.kind === 'tool')
  const current = items.find((item) => item.kind === 'reasoning' ? item.streaming : isLive(item) || (browsing && item.status === 'awaiting'))
  // Fast tools may finish between renderer frames while the exploration turn continues.
  const live = !!current || active
  const thinkingOnly = tools.length === 0
  const thoughtDuration = items.reduce((total, item) => total + (item.kind === 'reasoning' && item.endedAt ? Math.max(0, item.endedAt - item.ts) : 0), 0)
  const thoughtTime = formatDuration(thoughtDuration)
  const latestItemId = items[items.length - 1].id
  // Preserve collapse within this group across remounts; new groups start fresh.
  const collapseKey = `${disclosureKey}:${browsing ? 'browse' : 'explore'}`
  const collapsed = useStore((s) => s.activityCollapsed[collapseKey] ?? false)
  const setCollapsed = useStore((s) => s.setActivityCollapsed)
  const [disclosed, toggleDisclosure] = useDisclosure(live, `${live ? 'running' : 'complete'}:${latestItemId}`)
  const open = !collapsed && disclosed
  const toggle = (): void => {
    setCollapsed(collapseKey, open)
    if (!open && !disclosed) toggleDisclosure()
  }
  const title = browsing
    ? live ? open ? 'Browsing' : `Browsing ${plural(browsingPages(tools), 'page')}` : `Browsed ${plural(browsingPages(tools), 'page')}`
    : thinkingOnly
      ? live ? 'Thinking' : thoughtTime === '0s' ? 'Thought briefly' : `Thought for ${thoughtTime}`
      : live ? open ? 'Exploring' : exploreSummary(tools, 'Exploring') : exploreSummary(tools)
  const activity = useRef<HTMLDivElement>(null)
  const following = useRef({ itemId: latestItemId, enabled: true })
  useLayoutEffect(() => {
    if (following.current.itemId !== latestItemId) following.current = { itemId: latestItemId, enabled: true }
    if (open && following.current.enabled && activity.current) {
      activity.current.scrollTop = activity.current.scrollHeight
    }
  }, [items, latestItemId, open])
  const failed = tools.length === 1 && tools[0].status === 'error'
  return (
    <div className="explore-group">
      <Row
        icon={browsing ? <Globe size={13.5} className="text-subtle" /> : thinkingOnly ? <Lightbulb size={13.5} className="text-subtle" /> : <Search size={13.5} className="text-subtle" />}
        title={title}
        live={live}
        open={open}
        onToggle={toggle}
        trailing={failed ? <StatusMark item={tools[0]} /> : null}
      />
      {open && (
        <div className={cn('activity-reveal relative mb-1.5', live && 'explore-viewport')}>
          <div
            ref={activity}
            className={cn('py-1', live && 'max-h-48 overflow-y-auto overscroll-contain')}
            onScroll={(event) => {
              const target = event.currentTarget
              following.current = { itemId: latestItemId, enabled: target.scrollHeight - target.scrollTop - target.clientHeight < 24 }
            }}
          >
            {items.map((item) => item.kind === 'reasoning'
              ? item.text.trim() ? <Markdown key={item.id} text={item.text} className="py-1 text-[13.8px]! text-muted" /> : null
              : browsing && ctx ? <ToolBlock key={item.id} item={item} ctx={ctx} /> : <ExploreLine key={item.id} item={item} />)}
          </div>
        </div>
      )}
    </div>
  )
})

// Individual tools

function BashTool({ item }: { item: ToolItem; ctx: TimelineContext }): ReactNode {
  const input = item.input as { command?: string } | null
  const command = item.meta?.command ?? input?.command ?? item.detail ?? ''
  const foreground = item.status === 'running' && !item.meta?.background && !!command
  const [open, toggle] = useDisclosure(false, foreground ? 'running' : 'complete')
  const exit = item.meta?.exitCode
  const rawTitle = item.title.replace(/…$/, '').trim()
  const title = command && rawTitle && (command.startsWith(rawTitle) || rawTitle.includes(command)) ? 'Terminal command' : item.title
  return (
    <div className="my-1.5 overflow-hidden rounded-xl border border-line-strong bg-elev">
      <div className="px-3 py-1">
      <Row
        icon={<SquareTerminal size={13.5} className="text-subtle" />}
        title={title}
        live={isLive(item)}
        open={open}
        onToggle={toggle}
        trailing={
          <>
            {item.meta?.background && <span className="shrink-0 text-[12.1px] text-subtle">background</span>}
            {item.status === 'done' && typeof exit === 'number' && exit !== 0 && <span className="shrink-0 font-mono text-[12.1px] text-danger">exit {exit}</span>}
            <StatusMark item={item} />
          </>
        }
      />
      </div>
      {(open || foreground) && (
        <div className="activity-output-surface activity-reveal border-t border-line">
          {foreground ? (
            <div className="explore-viewport relative">
              {item.output ? <OutputBlock text={item.output} follow maxHeight={112} /> : <div className="shimmer px-3 py-3 text-[12.7px] text-muted">Running command…</div>}
            </div>
          ) : item.output ? (
            <div>
              <OutputBlock text={item.output} follow={isLive(item)} />
            </div>
          ) : item.status === 'error' && item.error ? (
            <div className="border-t border-line px-3 py-2 text-[13.2px] text-danger">{item.error}</div>
          ) : null}
        </div>
      )}
    </div>
  )
}

function EditTool({ item, ctx }: { item: ToolItem; ctx: TimelineContext }): ReactNode {
  const openFile = useStore((s) => s.openFile)
  const homeDir = useStore((s) => s.homeDir)
  const diffs = item.meta?.diffs ?? []
  const added = diffs.reduce((n, d) => n + d.added, 0)
  const removed = diffs.reduce((n, d) => n + d.removed, 0)
  const live = isLive(item)
  const [open, toggle] = useDisclosure(live, live ? 'editing' : 'complete')
  const patchViewport = useRef<HTMLDivElement>(null)
  const followPatch = useRef(true)
  const Icon = KIND_ICON[item.tool]
  const inputPreview = useMemo(() => {
    const input = (item.input ?? {}) as Record<string, unknown>
    if (diffs.length > 0) return null
    if (typeof input.content === 'string') return input.content
    if (typeof input.patch === 'string') return input.patch
    if (typeof input.new_string === 'string') return input.new_string
    return null
  }, [item.input, diffs.length])
  useLayoutEffect(() => {
    if (live && open && followPatch.current && patchViewport.current) patchViewport.current.scrollTop = patchViewport.current.scrollHeight
  }, [diffs, inputPreview, live, open])

  return (
    <div className="my-1.5 overflow-hidden rounded-xl border border-line-strong bg-elev">
      <div className="px-3 py-1">
      <Row
        icon={<Icon size={13.5} className="text-subtle" />}
        title={item.title}
        detail={item.tool === 'memory' ? item.detail : item.detail && item.detail !== basename(item.detail) ? item.detail : undefined}
        live={isLive(item)}
        open={open}
        onToggle={toggle}
        trailing={
          <>
            <DiffStat added={added} removed={removed} />
            <StatusMark item={item} />
          </>
        }
      />
      </div>
      {open && (
        <div className="activity-output-surface explore-viewport activity-reveal relative border-t border-line">
          <div ref={patchViewport} className="max-h-28 overflow-auto overscroll-contain py-2" onScroll={(event) => {
            const target = event.currentTarget
            followPatch.current = target.scrollHeight - target.scrollTop - target.clientHeight < 24
          }}>
          {diffs.map((diff) => (
            <div key={diff.path} className="border-b border-line last:border-b-0">
              <div className="flex h-7 items-center gap-2 border-b border-line px-3">
                <button type="button" onClick={() => openFile(diff.path)} className="min-w-0 truncate font-mono text-[12.7px] text-muted hover:text-fg hover:underline" title="Open beside the chat">
                  {relativeTo(ctx.root, diff.path, homeDir)}
                </button>
                {diff.created && <span className="shrink-0 text-[11.6px] uppercase tracking-wide text-ok">new</span>}
                {diff.deleted && <span className="shrink-0 text-[11.6px] uppercase tracking-wide text-danger">deleted</span>}
                <span className="flex-1" />
                <DiffStat added={diff.added} removed={diff.removed} />
              </div>
              <DiffView diff={diff} maxHeight={null} monochrome={live} />
            </div>
          ))}
          {diffs.length === 0 && inputPreview !== null && <pre className="selectable whitespace-pre-wrap break-words px-3 font-mono text-[13.2px] text-muted">{inputPreview}</pre>}
          {live && diffs.length === 0 && inputPreview === null && <div className="shimmer px-3 text-[13.2px]">Preparing changes…</div>}
          {item.status === 'error' && item.error && <div className="px-3 py-2 text-[13.2px] text-danger">{item.error}</div>}
          </div>
        </div>
      )}
    </div>
  )
}

function FileThumb({ path, className, fitImage = false }: { path: string; className?: string; fitImage?: boolean }): ReactNode {
  const [src, setSrc] = useState<string | null>(null)
  const [ratio, setRatio] = useState(1)
  const imageSize = fitImage ? { width: Math.min(208, 208 * ratio), maxWidth: '100%', aspectRatio: String(ratio) } : undefined
  const classes = cn(fitImage && 'shrink-0 transition-[width,aspect-ratio] duration-200 ease-out motion-reduce:transition-none', className)
  const openFile = useStore((s) => s.openFile)
  useEffect(() => {
    let cancelled = false
    void window.galaxy.files.read(path).then((view) => {
      if (!cancelled && view.kind === 'image' && view.dataUrl) setSrc(view.dataUrl)
    })
    return () => {
      cancelled = true
    }
  }, [path])
  if (!src) return <div style={imageSize} className={cn('flex items-center justify-center rounded-lg border border-line bg-inset text-subtle', classes)}><FileImage size={18} /></div>
  return (
    <button type="button" onClick={() => openFile(path)} style={imageSize} className={cn('overflow-hidden rounded-lg border border-line bg-inset', classes)} title={path}>
      <img src={src} alt="" className="block h-full w-full object-contain" draggable={false} onLoad={(event) => {
        const image = event.currentTarget
        if (fitImage && image.naturalWidth > 0 && image.naturalHeight > 0) setRatio(image.naturalWidth / image.naturalHeight)
      }} />
    </button>
  )
}

function GenericTool({ item }: { item: ToolItem; ctx: TimelineContext }): ReactNode {
  const awaiting = item.status === 'awaiting'
  const [open, toggle] = useDisclosure(awaiting)
  const Icon = KIND_ICON[item.tool]
  const images = item.meta?.images ?? []
  const input = useMemo(() => {
    const value = item.input
    if (!value || typeof value !== 'object' || Object.keys(value).length === 0) return ''
    return JSON.stringify(value, null, 2)
  }, [item.input])
  const expandable = !!input || !!item.output || awaiting || !!item.error
  return (
    <div>
      <Row
        icon={<Icon size={13.5} className="text-subtle" />}
        title={item.title}
        detail={item.tool === 'browser' || item.tool === 'image' ? undefined : item.detail}
        live={isLive(item)}
        open={open}
        onToggle={expandable ? toggle : undefined}
        trailing={<StatusMark item={item} />}
      />
      {images.length > 0 && item.status === 'done' && (
        <div className="mb-2 ml-6 flex flex-wrap gap-2">
          {images.map((path) => (
            <FileThumb key={path} path={path} fitImage={item.tool === 'image'} className={item.tool === 'image' ? undefined : 'h-28 w-44'} />
          ))}
        </div>
      )}
      {open && (
        <Panel>
          {input && (item.tool === 'mcp' || item.tool === 'other' || item.tool === 'browser' || awaiting) && <OutputBlock text={input} maxHeight={180} />}
          {item.output && (
            <div className={cn(input && (item.tool === 'mcp' || item.tool === 'other' || item.tool === 'browser' || awaiting) && 'border-t border-line')}>
              <OutputBlock text={item.output.slice(0, 12000)} />
            </div>
          )}
          {item.status === 'error' && item.error && !item.output && <div className="px-3 py-2 text-[13.2px] text-danger">{item.error}</div>}
        </Panel>
      )}
    </div>
  )
}

function OpenTool({ item }: { item: ToolItem }): ReactNode {
  const openFile = useStore((s) => s.openFile)
  const file = item.meta?.files?.[0]
  return (
    <Row
      icon={<PanelRight size={13.5} className="text-subtle" />}
      title={item.title}
      detail={item.detail}
      onToggle={file ? () => openFile(file.path) : undefined}
      trailing={<StatusMark item={item} />}
    />
  )
}

// Tasks

function TaskIcon({ status }: { status: TaskEntry['status'] }): ReactNode {
  if (status === 'completed') return <CircleCheck size={14} className="shrink-0 text-ok" />
  if (status === 'in_progress') return <CircleDot size={14} className="shrink-0 text-fg" />
  return <CircleDashed size={14} className="shrink-0 text-subtle" />
}

function TaskTool({ item, ctx }: { item: ToolItem; ctx: TimelineContext }): ReactNode {
  const tasks = item.meta?.tasks ?? []
  const latest = ctx.latestTaskId === item.id
  const [open, toggle] = useDisclosure(latest)
  const done = tasks.filter((t) => t.status === 'completed').length
  if (tasks.length === 0) return <Row icon={<ListTodo size={13.5} className="text-subtle" />} title={item.title} dim />
  return (
    <div>
      <Row
        icon={<ListTodo size={13.5} className="text-subtle" />}
        title={latest ? 'Tasks' : item.title}
        open={open}
        onToggle={toggle}
        dim={!latest}
        trailing={<span className="shrink-0 font-mono text-[12.1px] tabular-nums text-subtle">{done}/{tasks.length}</span>}
      />
      {open && (
        <div className="mb-2 ml-6 space-y-[3px] rounded-lg border border-line bg-inset px-3 py-2.5">
          {tasks.map((task, index) => (
            <div key={index} className="flex items-start gap-2 text-[13.8px] leading-[1.45]">
              <span className="mt-[2px]"><TaskIcon status={task.status} /></span>
              <span className={cn('selectable min-w-0', task.status === 'completed' ? 'text-subtle line-through decoration-line-strong' : task.status === 'in_progress' ? 'text-fg' : 'text-muted')}>
                {task.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Ask

function QuestionForm({ item, ctx, questions }: { item: ToolItem; ctx: TimelineContext; questions: AskQuestion[] }): ReactNode {
  const [selected, setSelected] = useState<Record<number, string[]>>({})
  const [other, setOther] = useState<Record<number, string>>({})

  const answerFor = (index: number): string => {
    const picks = selected[index] ?? []
    const custom = other[index]?.trim()
    return [...picks, ...(custom ? [custom] : [])].join(', ')
  }
  const complete = questions.every((_, index) => answerFor(index) !== '')

  const submit = (): void => {
    if (!complete) return
    const answers: Record<string, string> = {}
    questions.forEach((q, index) => {
      answers[q.question] = answerFor(index)
    })
    void window.galaxy.chats.answer(ctx.chatId, item.id, answers)
  }

  const pick = (index: number, label: string, multi: boolean): void => {
    setSelected((prev) => {
      const current = prev[index] ?? []
      const next = multi ? (current.includes(label) ? current.filter((l) => l !== label) : [...current, label]) : current.includes(label) ? [] : [label]
      return { ...prev, [index]: next }
    })
    if (!multi) setOther((prev) => ({ ...prev, [index]: '' }))
  }

  return (
    <div className="my-1.5 rounded-xl border border-line-strong bg-elev">
      <div className="space-y-4 px-4 py-3.5">
        {questions.map((q, index) => (
          <div key={index}>
            <div className="flex items-baseline gap-2">
              {q.header && <span className="shrink-0 rounded bg-hover px-1.5 py-px text-[11.6px] font-medium uppercase tracking-wide text-muted">{q.header}</span>}
              <div className="selectable text-[14.3px] font-medium text-fg">{q.question}</div>
            </div>
            <div className="mt-2 space-y-1">
              {q.options.map((option) => {
                const active = (selected[index] ?? []).includes(option.label)
                return (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => pick(index, option.label, !!q.multiSelect)}
                    className={cn(
                      'flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors',
                      active ? 'border-fg/50 bg-hover' : 'border-line hover:bg-hover'
                    )}
                  >
                    <span
                      className={cn(
                        'mt-[2px] flex h-[14px] w-[14px] shrink-0 items-center justify-center border',
                        q.multiSelect ? 'rounded-[4px]' : 'rounded-full',
                        active ? 'border-fg bg-fg text-bg' : 'border-line-strong'
                      )}
                    >
                      {active && <Check size={10} strokeWidth={3} />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13.8px] text-fg">{option.label}</span>
                      {option.description && <span className="block text-[13.2px] text-muted">{option.description}</span>}
                    </span>
                  </button>
                )
              })}
              <input
                value={other[index] ?? ''}
                onChange={(event) => {
                  const value = event.target.value
                  setOther((prev) => ({ ...prev, [index]: value }))
                  if (!q.multiSelect && value) setSelected((prev) => ({ ...prev, [index]: [] }))
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') submit()
                }}
                placeholder={q.options.length ? 'Something else…' : 'Type your answer…'}
                className="h-8 w-full rounded-lg border border-line bg-transparent px-2.5 text-[13.8px] placeholder:text-subtle focus:border-fg/40"
              />
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-end gap-1.5 border-t border-line px-3 py-2">
        <Button variant="ghost" size="sm" onClick={() => void window.galaxy.chats.answer(ctx.chatId, item.id, null)}>
          Skip
        </Button>
        <Button variant="primary" size="sm" disabled={!complete} onClick={submit}>
          Send answers
        </Button>
      </div>
    </div>
  )
}

function AskTool({ item, ctx }: { item: ToolItem; ctx: TimelineContext }): ReactNode {
  const questions = item.meta?.questions ?? []
  const answers = item.meta?.answers
  if (item.status === 'awaiting' && questions.length > 0) return <QuestionForm item={item} ctx={ctx} questions={questions} />
  return (
    <div className="my-1">
      <Row
        icon={<MessageCircleQuestion size={13.5} className="text-subtle" />}
        title={answers ? 'Asked a question' : item.title}
        live={isLive(item)}
        trailing={!answers && item.status !== 'running' ? <span className="shrink-0 text-[12.7px] text-subtle">Skipped</span> : null}
      />
      {answers && (
        <div className="mb-1.5 ml-6 space-y-1.5 border-l border-line pl-3">
          {questions.map((q) => (
            <div key={q.question} className="selectable text-[13.8px]">
              <div className="text-muted">{q.question}</div>
              <div className="text-fg">{answers[q.question] ?? ''}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Present

function fileIcon(mime: string): typeof FileIcon {
  if (mime.startsWith('image/')) return FileImage
  if (mime.startsWith('text/') || mime === 'application/json') return FileText
  return FileIcon
}

export function PresentTool({ item }: { item: ToolItem }): ReactNode {
  const openFile = useStore((s) => s.openFile)
  const files = item.meta?.files ?? []
  if (item.status !== 'done' || files.length === 0) {
    return <Row icon={<FileIcon size={13.5} className="text-subtle" />} title={item.title} live={isLive(item)} trailing={<StatusMark item={item} />} />
  }
  return (
    <div className="my-2">
      {item.meta?.summary && <div className="selectable mb-2 text-[13.8px] text-muted">{item.meta.summary}</div>}
      <div className="space-y-2">
        {files.map((file) => {
          const Icon = fileIcon(file.mime)
          return (
            <div key={file.path} className="group/file flex w-full items-center gap-3 rounded-xl border border-line-strong bg-elev px-4 py-3 transition-colors hover:bg-hover">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                {file.mime.startsWith('image/') && file.mime !== 'image/svg+xml' ? (
                  <FileThumb path={file.path} className="h-10 w-10 shrink-0" />
                ) : (
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-hover text-muted"><Icon size={18} /></span>
                )}
                <button type="button" onClick={() => openFile(file.path)} className="min-w-0 flex-1 text-left" title={file.path}>
                  <span className="block truncate text-[14.3px] font-medium text-fg">{file.name}</span>
                  <span className="block text-[12.1px] text-subtle">{formatBytes(file.size)}</span>
                </button>
              </div>
              <div className="hidden shrink-0 items-center gap-1 sm:flex">
                <button type="button" title="Show in folder" onClick={() => void window.galaxy.files.reveal(file.path)} className="rounded-md p-1 text-muted hover:bg-active hover:text-fg"><FolderOpen size={13.5} /></button>
                <button type="button" title="Open with default app" onClick={() => void window.galaxy.files.openExternal(file.path)} className="rounded-md p-1 text-muted hover:bg-active hover:text-fg"><ExternalLink size={13.5} /></button>
              </div>
              <Button onClick={() => openFile(file.path)} aria-label={`Open ${file.name}`}>Open <PanelRight size={13.5} /></Button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Subagents

function AgentTool({ item, ctx }: { item: ToolItem; ctx: TimelineContext }): ReactNode {
  const children = ctx.children.get(item.id) ?? []
  const live = isLive(item)
  const openAgent = useStore((s) => s.openAgent)
  const latest = useMemo(() => {
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]
      if (child.kind === 'tool') return toolActivityTitle(child)
      if (child.kind === 'assistant' && child.text.trim()) return child.text.trim().split('\n').pop()?.slice(0, 140) ?? ''
      if (child.kind === 'reasoning') return 'Thinking'
    }
    return 'Starting'
  }, [children])
  const steps = children.filter((c) => c.kind === 'tool').length

  return (
    <div className={cn('my-1.5 overflow-hidden rounded-xl border bg-elev', item.status === 'error' ? 'border-danger/30' : 'border-line-strong')}>
      <button type="button" onClick={() => openAgent(ctx.chatId, item.id, item.title, ctx.root)} className="group/agent flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-hover">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className={cn('truncate text-[13.8px] font-medium text-fg', live && 'shimmer')}>{item.title}</span>
          </span>
          <span className={cn('block truncate text-[12.7px]', live ? 'shimmer' : 'text-subtle')}>
            {live ? latest : item.status === 'error' ? (item.error ?? 'Failed') : `${plural(steps, 'step')}${item.endedAt ? ` · ${formatDuration(item.endedAt - item.ts)}` : ''}`}
          </span>
        </span>
        <PanelRight size={13} className="shrink-0 text-subtle" />
      </button>
    </div>
  )
}

export function isExplore(item: Item): item is ToolItem {
  return item.kind === 'tool' && EXPLORE_KINDS.includes(item.tool) && !item.approval && item.status !== 'awaiting'
}

export function isAgentMessage(item: Item): boolean {
  return item.kind === 'tool' && /(?:^|[_.:])Message$/.test(item.name)
}

export function isHiddenAgentMessage(item: Item): boolean {
  return item.kind === 'tool' && isAgentMessage(item) && (item.input as { action?: string } | null)?.action !== 'send'
}

export function isBrowsing(item: Item): item is ToolItem {
  return item.kind === 'tool' && (item.tool === 'browser' || (item.tool === 'webfetch' && item.status !== 'awaiting'))
}

export const ToolBlock = memo(function ToolBlock({ item, ctx }: { item: ToolItem; ctx: TimelineContext }): ReactNode {
  const title = toolActivityTitle(item)
  if (title !== item.title) item = { ...item, title }
  if (isAgentMessage(item)) {
    if (isHiddenAgentMessage(item)) return null
    const to = String((item.input as { to?: string } | null)?.to ?? 'agent')
    const recipient = ctx.agentNames.get(to) ?? item.meta?.recipientName
    const name = recipient && recipient !== to ? recipient : to === 'main' ? 'Main' : ctx.agentNames.get(to) ?? 'Subagent'
    return (
      <div className="flex h-7 min-w-0 items-center gap-2 text-[13.8px] text-muted">
        <span className="flex w-4 shrink-0 justify-center"><MessageCircle size={13} /></span>
        <span className={cn('truncate', isLive(item) && 'shimmer')}>{toolActivityTitle({ ...item, title: `Messaged to ${name}` })}</span>
        <StatusMark item={item} />
      </div>
    )
  }
  switch (item.tool) {
    case 'bash':
      return <BashTool item={item} ctx={ctx} />
    case 'edit':
    case 'create':
    case 'memory':
      return <EditTool item={item} ctx={ctx} />
    case 'agent':
      return <AgentTool item={item} ctx={ctx} />
    case 'ask':
      return <AskTool item={item} ctx={ctx} />
    case 'task':
      return <TaskTool item={item} ctx={ctx} />
    case 'present':
      return <PresentTool item={item} />
    case 'open':
      return <OpenTool item={item} />
    default:
      return <GenericTool item={item} ctx={ctx} />
  }
})
