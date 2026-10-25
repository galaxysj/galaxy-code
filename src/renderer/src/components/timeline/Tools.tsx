import {
  FileOutput,
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
  SearchCheck,
  Hourglass,
  BellRing,
  SquareTerminal,
  Wrench
} from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { EXPLORE_KINDS, type AskQuestion, type Item, type ReasoningItem, type TaskEntry, type ToolItem, type ToolKind } from '@shared/types'
import { basename, cn, formatBytes, formatDuration, plural, relativeTo } from '../../lib/utils'
import { attemptedTitle, isTerminalRead, isToolOutputRead, readPath, thinkingTopic, toolActivityTitle } from '../../lib/toolActivity'
import { useStore } from '../../store'
import { DiffStat, DiffView } from '../DiffView'
import { Markdown } from '../Markdown'
import { FileIcon as FileTypeIcon } from '../ProjectFiles'
import { Button, Spinner } from '../ui'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'

hljs.registerLanguage('bash', bash)

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
  lint: SearchCheck,
  wait: Hourglass,
  event: BellRing,
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
  open: FileIcon,
  memory: Brain,
  image: ImageIcon,
  other: Wrench
}

function isLive(item: ToolItem): boolean {
  return item.status === 'running' || item.status === 'pending'
}

function StatusMark({ item }: { item: ToolItem }): ReactNode {
  if (item.tool === 'bash' && item.status === 'error') return null
  // A failed call says so in its title ("Read attempted"), so there is no mark.
  if (item.status === 'error') return null
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
  /** No lead-word emphasis, for titles that are content rather than activity labels. */
  plain?: boolean
  /** Shown on hover, such as why a call failed. */
  hint?: string
}

/** One line of agent activity. Clicking it reveals the detail underneath. */
/** Emphasizes the leading verb of a plain-text title ("Explored 3 files"). */
function leadWord(title: ReactNode): ReactNode {
  if (typeof title !== 'string') return title
  const space = title.indexOf(' ')
  if (space <= 0) return title
  return <><span className="text-fg">{title.slice(0, space)}</span>{title.slice(space)}</>
}

function Row({ icon, title, detail, trailing, live, open, onToggle, dim, plain, hint }: RowProps): ReactNode {
  return (
    <span title={hint} className="contents">
    <button
      type="button"
      onClick={onToggle}
      disabled={!onToggle}
      aria-expanded={onToggle ? open : undefined}
      className={cn(
        'group/row flex h-7 w-full min-w-0 items-center gap-2 rounded-md text-left text-[13.8px] font-[450] transition-colors',
        onToggle ? 'hover:text-fg' : 'cursor-default',
        dim ? 'text-subtle' : 'text-muted'
      )}
    >
      <span className="flex w-4 shrink-0 justify-center">{live ? <Spinner size={13} /> : icon}</span>
      <span className={cn('min-w-0 shrink truncate', live && 'shimmer')}>{plain ? title : leadWord(title)}</span>
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
    </span>
  )
}

function Panel({ children, className }: { children: ReactNode; className?: string }): ReactNode {
  return <div className={cn('mb-1.5 ml-6 overflow-hidden rounded-lg border border-line bg-inset', className)}>{children}</div>
}

function OutputBlock({ text, follow, maxHeight = 300, command, highlight }: { text: string; follow?: boolean; maxHeight?: number | 'none'; command?: string; highlight?: boolean }): ReactNode {
  const ref = useRef<HTMLPreElement>(null)
  const html = useMemo(() => {
    if (!highlight) return null
    // Very large logs stay plain to keep highlighting fast.
    const body = text.length > 200_000 ? escapeHtml(text) : hljs.highlight(text, { language: 'bash' }).value
    return command ? `<span class="text-fg">$ </span>${hljs.highlight(command, { language: 'bash' }).value}${body ? `\n\n${body}` : ''}` : body
  }, [text, command, highlight])
  const following = useRef(true)
  useLayoutEffect(() => {
    if (follow && following.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [text, follow])
  return (
    <pre ref={ref} onScroll={(event) => {
      const el = event.currentTarget
      following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    }} className={cn('selectable overflow-auto overscroll-contain whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12.7px] leading-[1.55]', highlight ? 'text-fg' : 'text-muted')} style={{ maxHeight }}>
      {html === null ? text : <code dangerouslySetInnerHTML={{ __html: html }} />}
    </pre>
  )
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
}

/** Activity changes reset expansion; grouped activity can preserve an explicit collapse. */
/** `preserveCollapse` and `preserveOpen` keep a manual close or open when the activity key changes. */
/** Why a call failed, for the hover text of its "attempted" title. */
function failureReason(item: ToolItem): string | undefined {
  if (item.status !== 'error') return undefined
  if (item.tool === 'bash' && typeof item.meta?.exitCode === 'number') return undefined
  return item.error || item.output?.trim().split('\n').pop() || 'The call failed.'
}

function useDisclosure(auto: boolean, activityKey?: string, preserveCollapse = false, preserveOpen = false): [boolean, () => void] {
  const [manual, setManual] = useState<{ key?: string; open: boolean } | null>(null)
  const open = manual && (manual.key === activityKey || (preserveCollapse && !manual.open) || (preserveOpen && manual.open)) ? manual.open : auto
  return [open, () => setManual({ key: activityKey, open: !open })]
}

// Explore

/** An open group names what its latest tool call does; compact groups also edit and run commands. */
function liveVerb(items: ToolItem[]): string {
  const current = items[items.length - 1]
  if (current?.tool === 'edit' || current?.tool === 'create') return 'Editing'
  if (current?.tool === 'bash') return 'Running'
  if (current?.tool === 'wait' && items.every((item) => item.tool === 'wait')) return 'Waiting'
  return 'Exploring'
}

/** One word that scrolls up when it changes: the old word leaves through the top as the new one rises in. */
function RollingWord({ value, animate }: { value: string; animate: boolean }): ReactNode {
  const [state, setState] = useState({ current: value, previous: null as string | null, step: animate ? 1 : 0 })
  if (state.current !== value) setState({ current: value, previous: state.current, step: state.step + 1 })
  return (
    <span className="roll-slot">
      {state.previous !== null && <span key={`out:${state.step}`} className="roll-out" onAnimationEnd={() => setState((now) => ({ ...now, previous: null }))}>{state.previous}</span>}
      <span key={`in:${state.step}`} className={state.step ? 'roll-in' : undefined}>{state.current}</span>
    </span>
  )
}

/** Live text where only the words that change scroll up. Spaces and commas stay put. A shimmer on a parent sweeps across it as one. */
export function RollingText({ text, effect = 'roll' }: { text: string; effect?: 'roll' | 'blur' }): ReactNode {
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true }, [])
  return text.split(/(\s+|,)/).map((part, index) => /^(\s+|,)?$/.test(part) ? <span key={index}>{part}</span> : effect === 'blur' ? <BlurWord key={index} value={part} animate={mounted.current} /> : <RollingWord key={index} value={part} animate={mounted.current} />)
}

/** A live summary whose counts roll in as they change. */
function rollingSummary(summary: string): ReactNode {
  const space = summary.indexOf(' ')
  if (space <= 0) return <RollingText text={summary} />
  // The verb stays bold, as in every other row; it paints its own color through the row's shimmer.
  return <><span className="text-fg [-webkit-text-fill-color:currentColor]">{summary.slice(0, space)}</span><RollingText text={summary.slice(space)} effect="blur" /></>
}

/** The part of `next` that differs from `previous`, as the unchanged start, the changed middle and the unchanged end. */
function changedPart(previous: string, next: string): [string, string, string] {
  let start = 0
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++
  let end = 0
  while (end < previous.length - start && end < next.length - start && previous[previous.length - 1 - end] === next[next.length - 1 - end]) end++
  return [next.slice(0, start), next.slice(start, next.length - end), next.slice(next.length - end)]
}

/**
 * A word whose changed letters blur-fade in, such as 1 → 2 and the added s in "file" → "files".
 * While they animate they carry their own shimmer, since the filter takes them out of the parent's.
 */
function BlurWord({ value, animate }: { value: string; animate: boolean }): ReactNode {
  const [state, setState] = useState({ current: value, previous: animate ? '' : value, step: 0 })
  if (state.current !== value) setState({ current: value, previous: state.current, step: state.step + 1 })
  const [head, changed, tail] = changedPart(state.previous, state.current)
  if (!changed) return state.current
  return <>{head}<span key={state.step} className="blur-fade shimmer inline-block whitespace-pre" onAnimationEnd={() => setState((now) => ({ ...now, previous: now.current }))}>{changed}</span>{tail}</>
}

function exploreSummary(all: ToolItem[], verb = 'Explored'): string {
  // Failed calls are not counted; a group where every call failed says so instead.
  const items = all.filter((item) => item.status !== 'error')
  if (all.length && !items.length) return verb === 'Exploring' ? verb : 'Explore attempted'
  const reads = items.filter((i) => i.tool === 'read' && !i.meta?.skill)
  const terminals = reads.filter(isTerminalRead).length
  const outputs = reads.filter(isToolOutputRead).length
  const files = reads.length - terminals - outputs
  const skills = items.filter((i) => i.meta?.skill).length
  const searches = items.filter((i) => i.tool === 'grep' || i.tool === 'glob').length
  const lists = items.filter((i) => i.tool === 'list').length
  const lints = items.some((i) => i.tool === 'lint')
  const web = items.filter((i) => i.tool === 'websearch').length
  const pages = items.filter((i) => i.tool === 'webfetch' || i.tool === 'browser').length
  const commands = items.filter((i) => i.tool === 'bash').length
  const edited = new Set(items.filter((i) => i.tool === 'edit' || i.tool === 'create').flatMap((i) => i.meta?.diffs?.map((d) => d.path) ?? [i.id])).size
  const others = items.filter((i) => !EXPLORE_KINDS.includes(i.tool) && !['bash', 'edit', 'create', 'browser'].includes(i.tool)).length
  const parts = [
    files && plural(files, 'file'),
    terminals && plural(terminals, 'terminal'),
    outputs && plural(outputs, 'tool output'),
    skills && plural(skills, 'skill'),
    searches && plural(searches, 'search', 'searches'),
    lists && plural(lists, 'folder'),
    // Always "lints", never counted.
    lints && 'lints',
    web && plural(web, 'web search', 'web searches'),
    pages && plural(pages, 'page')
  ].filter(Boolean)
  // A single item names what it was rather than counting to one.
  if (items.length === 1 && reads.length === 1) parts[0] = terminals ? 'terminal' : outputs ? 'tool output' : basename(readPath(reads[0]))
  else if (items.length === 1 && web === 1) parts[0] = 'web search'
  const done = verb === 'Explored'
  const actions = [
    commands && `${done ? 'ran' : 'running'} ${plural(commands, 'command')}`,
    edited && `${done ? 'edited' : 'editing'} ${plural(edited, 'file')}`,
    others && `${done ? 'used' : 'using'} ${plural(others, 'tool')}`
  ].filter((part): part is string => !!part)
  // Waits sit in the group without being listed; on their own the group reads "Waited".
  if (!parts.length && !actions.length && items.some((i) => i.tool === 'wait')) return done ? 'Waited' : verb
  if (!parts.length && actions.length) actions[0] = actions[0].charAt(0).toUpperCase() + actions[0].slice(1)
  return [parts.length ? `${verb} ${parts.join(', ')}` : '', ...actions].filter(Boolean).join(', ')
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
  const Icon = isTerminalRead(item) ? SquareTerminal : isToolOutputRead(item) ? FileOutput : KIND_ICON[item.tool]
  const path = isTerminalRead(item) || isToolOutputRead(item) ? undefined : item.tool === 'read' && typeof (item.input as { path?: string; file_path?: string })?.path === 'string' ? (item.input as { path: string }).path : (item.input as { file_path?: string })?.file_path
  const url = item.meta?.url
  const results = item.meta?.results
  const outputMode = useStore((s) => s.settings.terminalOutput)
  const editing = item.tool === 'edit' || item.tool === 'create'
  const [open, toggle] = useDisclosure(false, `${outputMode}:${isLive(item) ? 'running' : 'complete'}`)
  const diffs = item.tool === 'edit' || item.tool === 'create' ? item.meta?.diffs ?? [] : []
  const preview = !open && editing && diffs.length > 0 && (outputMode === 'preview' || outputMode === 'foreground' && isLive(item))
  const command = item.tool === 'bash' ? item.meta?.command ?? (item.input as { command?: string } | null)?.command ?? '' : ''
  // Grouped commands and edits expand in place, like their standalone blocks.
  const expandable = item.tool === 'bash' ? !!(item.output || item.error) : diffs.length > 0
  const action = expandable ? toggle : path ? () => openFile(path) : url ? () => void window.galaxy.files.openExternal(url) : results?.length ? toggle : undefined
  if (item.tool === 'mcp') return <McpTool item={item} />
  return (
    <div title={failureReason(item)}>
      <button
        type="button"
        disabled={!action}
        onClick={action}
        className={cn('flex h-7 w-full min-w-0 items-center gap-2 text-left text-[13.8px] font-[450] text-muted', action && 'hover:text-fg')}
      >
        <span className="flex w-4 shrink-0 justify-center">{isLive(item) ? <Spinner size={13} /> : <Icon size={13.5} className="text-subtle" />}</span>
        <span className={cn('min-w-0 truncate', isLive(item) && 'shimmer')}>{leadWord(item.tool === 'bash' && item.status !== 'error' ? `${isLive(item) ? 'Running' : 'Ran'} ${toolActivityTitle(item)}` : toolActivityTitle(item))}</span>
        {!isTerminalRead(item) && !isToolOutputRead(item) && item.detail && item.detail !== basename(item.detail) && <span className="min-w-0 flex-1 truncate font-mono text-[12.1px] text-subtle">{item.detail}</span>}
        {item.meta?.matches !== undefined && item.tool !== 'read' && <span className="shrink-0 text-[12.1px] text-subtle">{plural(item.meta.matches, 'match', 'matches')}</span>}
        <StatusMark item={item} />
      </button>
      {(open || preview) && expandable && (
        <div className={cn('activity-output-surface activity-reveal mb-1.5 ml-6 overflow-hidden rounded-lg border border-line', preview && 'max-h-[78px] overflow-y-auto overscroll-contain')}>
          {item.tool === 'bash'
            ? item.output ? <OutputBlock text={item.output} command={command} highlight maxHeight="none" /> : <div className="px-3 py-2 text-[13.2px] text-danger">{item.error}</div>
            : diffs.map((diff) => <DiffView key={diff.path} diff={diff} maxHeight={null} />)}
        </div>
      )}
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
  const expand = useStore((s) => s.settings.expandToolCalls !== false)
  const [disclosed, toggleDisclosure] = useDisclosure(live && expand, expand ? `${live ? 'running' : 'complete'}:${latestItemId}` : 'manual')
  const open = !collapsed && disclosed
  // Content mounts on first open and stays, so closing can animate.
  const [shown, setShown] = useState(open)
  useEffect(() => { if (open) setShown(true) }, [open])
  const toggle = (): void => {
    setCollapsed(collapseKey, open)
    if (!open && !disclosed) toggleDisclosure()
  }
  const title = browsing
    ? live ? open ? 'Browsing' : `Browsing ${plural(browsingPages(tools), 'page')}` : `Browsed ${plural(browsingPages(tools), 'page')}`
    : thinkingOnly
      ? live ? (current?.kind === 'reasoning' && thinkingTopic(current.text)) || 'Thinking' : thoughtTime === '0s' ? 'Thought briefly' : `Thought for ${thoughtTime}`
      : live ? open ? liveVerb(tools) : rollingSummary(exploreSummary(tools, 'Exploring')) : exploreSummary(tools)
  const activity = useRef<HTMLDivElement>(null)
  const following = useRef({ itemId: latestItemId, enabled: true })
  useLayoutEffect(() => {
    if (following.current.itemId !== latestItemId) following.current = { itemId: latestItemId, enabled: true }
    if (open && following.current.enabled && activity.current) {
      activity.current.scrollTop = activity.current.scrollHeight
    }
  }, [items, latestItemId, open])
  const failed = tools.length === 1 && tools[0].status === 'error'
  const failures = tools.filter((tool) => tool.status === 'error')
  return (
    <div className="explore-group" title={failures.length && failures.length === tools.length ? failures.map((tool) => `${toolActivityTitle({ ...tool, status: 'done' })}: ${failureReason(tool)}`).join('\n') : undefined}>
      <Row
        icon={browsing ? <Globe size={13.5} className="text-subtle" /> : thinkingOnly ? <Lightbulb size={13.5} className="text-subtle" /> : <Search size={13.5} className="text-subtle" />}
        title={title}
        live={live}
        open={open}
        onToggle={toggle}
        trailing={failed ? <StatusMark item={tools[0]} /> : null}
      />
      {(open || shown) && (
        <div className="fold" data-open={open && shown} inert={!open}>
        <div className={cn('relative mb-1.5 min-h-0 overflow-hidden', live && 'explore-viewport')}>
          <div
            ref={activity}
            className={cn('py-1', live && 'max-h-48 overflow-y-auto overscroll-contain')}
            onScroll={(event) => {
              const target = event.currentTarget
              following.current = { itemId: latestItemId, enabled: target.scrollHeight - target.scrollTop - target.clientHeight < 24 }
            }}
          >
            {items.map((item) => item.kind === 'reasoning'
              ? !item.text.trim() ? null
                : thinkingOnly ? <Markdown key={item.id} text={item.text} className="py-1 text-[13.8px]! text-muted" />
                : <ThinkingLine key={item.id} item={item} exploring={live} />
              : browsing && ctx ? <ToolBlock key={item.id} item={item} ctx={ctx} /> : <ExploreLine key={item.id} item={item} />)}
          </div>
        </div>
        </div>
      )}
    </div>
  )
})

/** A thought among exploration steps: its own collapsible block, like a thinking-only group. */
function ThinkingLine({ item, exploring }: { item: ReasoningItem; exploring: boolean }): ReactNode {
  // Open while the exploration runs, closed once it is done, unless toggled by hand.
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? exploring
  const live = !!item.streaming
  const time = formatDuration(item.endedAt ? Math.max(0, item.endedAt - item.ts) : 0)
  const title = live ? thinkingTopic(item.text) ?? 'Thinking' : time === '0s' ? 'Thought briefly' : `Thought for ${time}`
  return (
    <div>
      <Row icon={<Lightbulb size={13.5} className="text-subtle" />} title={title} live={live} open={open} onToggle={() => setManual(!open)} />
      {open && <Markdown text={item.text} className="py-1 pl-6 text-[13.8px]! text-muted" />}
    </div>
  )
}

// Individual tools

/** Follows a background command's log file while it is shown. */
function useBackgroundLog(path: string | undefined, shown: boolean): string | null {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    if (!path || !shown) return
    let alive = true
    const read = (): void => {
      void window.galaxy.files.read(path).then((view) => {
        if (!alive || view.kind !== 'text') return
        setText(view.content ?? '')
        // The shell appends this line once the process ends; the log is final.
        if (/\n\[(process exited|failed to start)/.test(view.content ?? '')) clearInterval(timer)
      }).catch(() => {})
    }
    const timer = setInterval(read, 1500)
    read()
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [path, shown])
  return text
}

function BashTool({ item }: { item: ToolItem; ctx: TimelineContext }): ReactNode {
  const input = item.input as { command?: string } | null
  const command = item.meta?.command ?? input?.command ?? item.detail ?? ''
  const mode = useStore((s) => s.settings.terminalOutput)
  const foreground = item.status === 'running' && !item.meta?.background && !!command
  const [open, toggle] = useDisclosure(false, foreground ? 'running' : 'complete', false, true)
  // A collapsed preview: the running command, or every command in preview mode.
  const backgroundLog = useBackgroundLog(item.meta?.log ?? (item.meta?.background ? item.output?.match(/Output is being written to (\S+\.log)/)?.[1] : undefined), open || mode === 'preview')
  const output = backgroundLog ?? item.output
  const preview = !open && (mode === 'preview' ? !!output || foreground : mode === 'foreground' && foreground)
  const exit = item.meta?.exitCode
  const rawTitle = item.title.replace(/…$/, '').trim()
  const title = attemptedTitle(item) ?? (command && rawTitle && (command.startsWith(rawTitle) || rawTitle.includes(command)) ? 'Terminal command' : item.title)
  return (
    <div className="my-1.5 overflow-hidden rounded-xl border border-line-strong bg-elev">
      <div className="px-3 py-1">
      <Row
        plain
        icon={<SquareTerminal size={13.5} className="text-subtle" />}
        title={title}
        hint={failureReason(item)}
        live={isLive(item)}
        open={open}
        onToggle={toggle}
        trailing={
          <>
            {item.meta?.background && <span className="shrink-0 text-[12.1px] text-subtle">background</span>}
            {(item.status === 'done' || item.status === 'error') && typeof exit === 'number' && exit !== 0 && <span className="shrink-0 font-mono text-[12.1px] text-danger">exit {exit}</span>}
            <StatusMark item={item} />
          </>
        }
      />
      </div>
      {(open || preview) && (
        <div className="activity-output-surface activity-reveal border-t border-line">
          {preview ? (
            <div className="explore-viewport relative">
              {output ? <OutputBlock text={output} follow maxHeight={78} /> : <div className="shimmer px-3 py-3 text-[12.7px] text-muted">Running command…</div>}
            </div>
          ) : output || command ? (
            <div>
              {/* The full command shows even before it prints anything. */}
              <OutputBlock text={output ?? ''} command={command} highlight follow={isLive(item) || !!backgroundLog} maxHeight="none" />
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
  const outputMode = useStore((s) => s.settings.terminalOutput)
  const diffs = item.meta?.diffs ?? []
  const added = diffs.reduce((n, d) => n + d.added, 0)
  const removed = diffs.reduce((n, d) => n + d.removed, 0)
  const live = isLive(item)
  const [open, toggle] = useDisclosure(false, `${outputMode}:${live ? 'editing' : 'complete'}`)
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
  const preview = !open && (diffs.length > 0 || inputPreview !== null || live) && (outputMode === 'preview' || outputMode === 'foreground' && live)
  useLayoutEffect(() => {
    if (live && preview && followPatch.current && patchViewport.current) patchViewport.current.scrollTop = patchViewport.current.scrollHeight
  }, [diffs, inputPreview, live, preview])

  return (
    <div className="my-1.5 overflow-hidden rounded-xl border border-line-strong bg-elev">
      <div className="px-3 py-1">
      <Row
        icon={<Icon size={13.5} className="text-subtle" />}
        title={attemptedTitle(item) ?? item.title}
        hint={failureReason(item)}
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
      {(open || preview) && (
        <div className={cn('activity-output-surface activity-reveal relative border-t border-line', preview && 'explore-viewport')}>
          <div ref={patchViewport} className={cn('py-2', preview && 'max-h-[78px] overflow-auto overscroll-contain')} onScroll={(event) => {
            const target = event.currentTarget
            followPatch.current = target.scrollHeight - target.scrollTop - target.clientHeight < 24
          }}>
          {diffs.map((diff) => (
            <div key={diff.path} className="border-b border-line last:border-b-0">
              {diffs.length > 1 && <div className="sticky top-0 z-10 flex h-7 items-center gap-2 border-b border-line bg-elev px-3">
                <button type="button" onClick={() => openFile(diff.path)} className="min-w-0 truncate font-mono text-[12.7px] text-muted hover:text-fg hover:underline" title="Open beside the chat">
                  {relativeTo(ctx.root, diff.path, homeDir)}
                </button>
                {diff.created && <span className="shrink-0 text-[11.6px] uppercase tracking-wide text-ok">new</span>}
                {diff.deleted && <span className="shrink-0 text-[11.6px] uppercase tracking-wide text-danger">deleted</span>}
                <span className="flex-1" />
                <DiffStat added={diff.added} removed={diff.removed} />
              </div>}
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

function McpTool({ item }: { item: ToolItem }): ReactNode {
  const [open, toggle] = useDisclosure(false)
  const input = useMemo(() => JSON.stringify(item.input ?? {}, null, 2), [item.input])
  const images = item.meta?.images ?? []
  return (
    <div>
      <Row icon={<Plug size={13.5} className="text-subtle" />} title={toolActivityTitle(item)} live={isLive(item)} open={open} onToggle={toggle} trailing={<StatusMark item={item} />} plain />
      {open && (
        <Panel className="activity-reveal">
          <div className="border-b border-line px-3 py-2">
            <div className="text-[11px] font-medium text-subtle">Call</div>
            <div className="selectable mt-1 break-all font-mono text-[12px] text-muted">{item.name}</div>
          </div>
          <OutputBlock text={input} maxHeight={240} />
          <div className="border-t border-line px-3 py-2 text-[11px] font-medium text-subtle">Result</div>
          {item.output ? <OutputBlock text={item.output} follow={isLive(item)} /> : (
            <div className="px-3 pb-3 text-[12px] text-muted">{isLive(item) ? 'Waiting for result…' : item.status === 'denied' ? 'Call denied.' : 'No result returned.'}</div>
          )}
          {item.error && <div className="selectable border-t border-line px-3 py-2 text-[12px] text-danger">{item.error}</div>}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 border-t border-line p-3">
              {images.map((path) => <FileThumb key={path} path={path} className="h-28 w-44" />)}
            </div>
          )}
        </Panel>
      )}
    </div>
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
        title={attemptedTitle(item) ?? item.title}
        hint={failureReason(item)}
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

/** Memory writes show as one plain line; the note is in the tooltip. */
function MemoryTool({ item }: { item: ToolItem }): ReactNode {
  const openFile = useStore((s) => s.openFile)
  const path = item.meta?.diffs?.[0]?.path
  const title = /^Remov/.test(item.title) ? 'Removed memory' : 'Saved memory'
  return (
    <div title={item.detail || undefined}>
      <Row icon={<Brain size={13.5} className="text-subtle" />} title={title} live={isLive(item)} onToggle={path ? () => openFile(path) : undefined} trailing={<StatusMark item={item} />} />
    </div>
  )
}

function OpenTool({ item }: { item: ToolItem }): ReactNode {
  const openFile = useStore((s) => s.openFile)
  const file = item.meta?.files?.[0]
  return (
    <Row
      icon={<FileIcon size={13.5} className="text-subtle" />}
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

export function PresentTool({ item }: { item: ToolItem }): ReactNode {
  const openFile = useStore((s) => s.openFile)
  const files = item.meta?.files ?? []
  if (item.status !== 'done' || files.length === 0) {
    return <Row icon={<FileIcon size={13.5} className="text-subtle" />} title={item.title} live={isLive(item)} trailing={<StatusMark item={item} />} />
  }
  return (
    <div className="my-2">
      <div className="space-y-2">
        {files.map((file) => {
          return (
            <div key={file.path} className="group/file flex w-full items-center gap-3 rounded-lg border border-line px-4 py-3">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center"><FileTypeIcon name={file.name} size={24} /></span>
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
      if (child.kind === 'reasoning') return (child.streaming && thinkingTopic(child.text)) || 'Thinking'
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
  // Event calls only set up a trigger; the timeline shows it as "Will resume after" instead.
  if (item.kind === 'tool' && item.tool === 'event') return true
  return item.kind === 'tool' && isAgentMessage(item) && (item.input as { action?: string } | null)?.action !== 'send'
}

/** Tools that Compact density folds into a summary line; questions, plans and approvals stay visible. */
export function isCompactable(item: Item): item is ToolItem {
  return item.kind === 'tool' && !item.approval && item.status !== 'awaiting' && !['ask', 'task', 'agent', 'present'].includes(item.tool) && !isAgentMessage(item)
}

export function isBrowsing(item: Item): item is ToolItem {
  return item.kind === 'tool' && (item.tool === 'browser' || (item.tool === 'webfetch' && item.status !== 'awaiting'))
}

export const ToolBlock = memo(function ToolBlock({ item, ctx }: { item: ToolItem; ctx: TimelineContext }): ReactNode {
  const medium = useStore((s) => s.settings.toolDensity === 'medium')
  const title = toolActivityTitle(item)
  if (title !== item.title) item = { ...item, title }
  // Medium keeps commands and edits on their own line, without the card; approvals still get the full card.
  if (medium && ['bash', 'edit', 'create'].includes(item.tool) && !item.approval && item.status !== 'awaiting') return <ExploreLine item={item} />
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
    case 'mcp':
      return <McpTool item={item} />
    case 'bash':
      return <BashTool item={item} ctx={ctx} />
    case 'edit':
    case 'create':
      return <EditTool item={item} ctx={ctx} />
    case 'memory':
      return <MemoryTool item={item} />
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
