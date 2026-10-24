import { ArrowDown, ChevronRight, CircleAlert, CircleStop, Clock, File as FileIcon, FileText, GitCommitHorizontal, Globe, Info, MessageCircle, Package, Plug, Redo2, SquareTerminal, Undo2 } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AssistantItem, Chat, FileDiff, Item, MentionChip, NoticeItem, ReasoningItem, ToolItem, TurnItem, UserItem } from '@shared/types'
import { basename, cn, formatBytes, formatDuration, plural } from '../../lib/utils'
import { toolActivityTitle } from '../../lib/toolActivity'
import { useStore } from '../../store'
import { DiffStat } from '../DiffView'
import { Composer } from '../Composer'
import { Markdown } from '../Markdown'
import { FileIcon as FileTypeIcon } from '../ProjectFiles'
import { cleanError } from '../Settings'
import { Button, CopyButton, IconButton, Modal } from '../ui'
import { ExploreGroup, isBrowsing, isCompactable, isExplore, isHiddenAgentMessage, PresentTool, ToolBlock, type TimelineContext } from './Tools'

const CHIP_ICON = { skill: Package, file: FileText, chat: MessageCircle, browser: Globe, mcp: Plug, terminal: SquareTerminal, git: GitCommitHorizontal }

/** Shows the / and @ picks in a sent message as inline chips. */
function MessageText({ text, mentions }: { text: string; mentions?: MentionChip[] }): ReactNode {
  if (!mentions?.length) return text
  const byToken = new Map(mentions.map((chip) => [chip.token, chip]))
  const pattern = new RegExp(`(${[...byToken.keys()].sort((a, b) => b.length - a.length).map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g')
  return text.split(pattern).map((part, index) => {
    const chip = byToken.get(part)
    if (!chip) return part
    const Icon = CHIP_ICON[chip.kind]
    return (
      <span key={index} title={chip.title ?? part} className="whitespace-nowrap text-link" style={chip.kind === 'git' ? { color: 'var(--orange)' } : undefined}>
        <span className="mr-[0.3em] inline-flex h-[1em] items-center align-[-0.15em]">{chip.kind === 'file' ? <FileTypeIcon name={chip.label} size={11} /> : <Icon size={13} />}</span>
        {chip.label}
      </span>
    )
  })
}

/** A Build message carries a one-line instruction, then the plan itself. */
function planBody(text: string): string {
  const split = text.indexOf('\n\n')
  return split < 0 ? text : text.slice(split + 2)
}

const UserMessage = memo(function UserMessage({ item, chatId }: { item: UserItem; chatId: string }): ReactNode {
  const openAttachment = useStore((s) => s.openAttachment)
  const openFile = useStore((s) => s.openFile)
  const idle = useStore((s) => s.chats[chatId]?.status !== 'running' && s.chats[chatId]?.status !== 'awaiting')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const revert = (): void => {
    setBusy(true)
    window.galaxy.chats.revert(chatId, item.id).catch((err: unknown) => setError(cleanError(err))).finally(() => setBusy(false))
  }
  return (
    <div className="group/user flex flex-col items-end pb-1 pt-5 first:pt-0">
      {item.attachments.length > 0 && (
        <div className="mb-1.5 flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {item.attachments.map((file) =>
            file.preview ? (
              <button key={file.id} type="button" onClick={() => openAttachment(file)} className="h-16 w-16 cursor-zoom-in overflow-hidden rounded-lg border border-line" title={file.name}>
                <img src={file.preview} alt="" className="h-full w-full object-cover" draggable={false} />
              </button>
            ) : (
              <button key={file.id} type="button" onClick={() => openAttachment(file)} className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-elev px-2 text-[12px] text-muted hover:text-fg" title={file.path}>
                <FileIcon size={12.5} />
                <span className="max-w-[160px] truncate">{file.name}</span>
                <span className="text-subtle">{formatBytes(file.size)}</span>
              </button>
            )
          )}
        </div>
      )}
      {item.mode && <div className="mb-1 text-[11.5px] font-medium text-subtle">{item.mode === 'plan' ? 'Plan mode' : 'Ask mode'}</div>}
      {item.plan ? (
        <div role="button" tabIndex={0} title="Open the plan" onClick={() => openFile(item.plan!)} onKeyDown={(event) => { if (event.key === 'Enter') openFile(item.plan!) }} className="-mx-2.5 flex flex-col self-stretch rounded-xl bg-elev py-2 pl-2.5 pr-1.5 text-left shadow-[0_0_0_1px_var(--border)]">
          <div className="flex items-center gap-2">
            <FileText size={14} className="shrink-0" style={{ color: 'var(--orange)' }} />
            <span className="shrink-0 text-[13.5px] font-medium text-fg">Build plan</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-subtle" title={item.plan}>{basename(item.plan)}</span>
            {item.revertible && idle && (
              <IconButton label="Revert to before this message" size="sm" disabled={busy} onClick={(event) => { event.stopPropagation(); revert() }} className="shrink-0 text-subtle">
                <Undo2 size={14} />
              </IconButton>
            )}
          </div>
          <div className="plan-preview relative mt-1.5 max-h-[6.2em] overflow-hidden pr-1 text-[13px] leading-[1.55]">
            <Markdown text={planBody(item.text)} root={item.plan.slice(0, item.plan.lastIndexOf('/'))} />
          </div>
        </div>
      ) : item.text && (
        <div className="-mx-2.5 flex items-start gap-2 self-stretch rounded-xl bg-elev py-2 pl-2.5 pr-1.5 shadow-[0_0_0_1px_var(--border)]">
          <div className="selectable min-w-0 flex-1 whitespace-pre-wrap break-words text-[14.7px] leading-[1.55] text-fg">
            <MessageText text={item.text} mentions={item.mentions} />
          </div>
          {item.revertible && idle && (
            <IconButton label="Revert to before this message" size="sm" disabled={busy} onClick={revert} className="shrink-0 text-subtle">
              <Undo2 size={14} />
            </IconButton>
          )}
        </div>
      )}
      {error && <ErrorDialog title="Could not revert" message={error} onClose={() => setError(null)} />}
      <div className="mt-0.5 flex h-5 items-center opacity-0 transition-opacity group-hover/user:opacity-100">
        <CopyButton text={item.text} label="Copy message" size={12} />
      </div>
    </div>
  )
})

function ErrorDialog({ title, message, onClose }: { title: string; message: string; onClose(): void }): ReactNode {
  return (
    <Modal onClose={onClose} className="w-[420px] max-w-full p-5">
      <div className="flex items-start gap-3">
        <CircleAlert size={18} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-fg">{title}</div>
          <div className="selectable mt-1.5 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-muted">{message}</div>
        </div>
      </div>
      <div className="mt-5 flex justify-end">
        <Button variant="primary" size="sm" onClick={onClose}>OK</Button>
      </div>
    </Modal>
  )
}

/** After a revert: the reverted message in a message box of its own, plus redo below it. */
function RevertedEditor({ chat }: { chat: Chat }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const redo = (): void => {
    setBusy(true)
    window.galaxy.chats.redo(chat.id).catch((err: unknown) => setError(cleanError(err))).finally(() => setBusy(false))
  }
  return (
    <div className="activity-reveal pt-5">
      <Composer
        edit={{ key: `revert:${chat.id}`, message: chat.reverted! }}
        footer={
          <div className="mt-2 flex items-center gap-2 pl-1">
            <Button size="sm" disabled={busy} onClick={redo}>
              <Redo2 size={13} /> Redo changes
            </Button>
            <span className="text-[11.5px] text-subtle">Edit and send to continue from here.</span>
          </div>
        }
      />
      {error && <ErrorDialog title="Could not redo" message={error} onClose={() => setError(null)} />}
    </div>
  )
}

const AssistantMessage = memo(function AssistantMessage({ item, root }: { item: AssistantItem; root: string | null }): ReactNode {
  if (!item.text.trim()) return null
  return (
    <div className="py-1.5">
      <Markdown text={item.text} root={root} className="text-[16.2px]!" />
    </div>
  )
})

function Notice({ item }: { item: NoticeItem }): ReactNode {
  if (item.level === 'error') {
    return (
      <div className="my-2 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-[12.5px] text-fg">
        <CircleAlert size={14} className="mt-[2px] shrink-0 text-danger" />
        <span className="selectable min-w-0 whitespace-pre-wrap break-words">{item.text}</span>
      </div>
    )
  }
  return (
    <div className="flex h-7 items-center gap-2 text-[12px] text-subtle">
      <span className="flex w-4 shrink-0 justify-center"><Info size={13} /></span>
      <span className="selectable truncate">{item.text}</span>
    </div>
  )
}

function mergeDiffs(items: ToolItem[]): FileDiff[] {
  const merged = new Map<string, FileDiff>()
  for (const item of items) {
    if (item.tool !== 'edit' && item.tool !== 'create') continue
    if (item.status !== 'done') continue
    for (const diff of item.meta?.diffs ?? []) {
      const existing = merged.get(diff.path)
      if (existing) {
        existing.added += diff.added
        existing.removed += diff.removed
        existing.deleted = diff.deleted
      } else {
        merged.set(diff.path, { ...diff })
      }
    }
  }
  return [...merged.values()]
}

function TurnFooter({ item, folded, changes, answer, root }: { item: TurnItem; folded: boolean; changes: FileDiff[]; answer: string; root: string | null }): ReactNode {
  const openFile = useStore((s) => s.openFile)
  const [open, setOpen] = useState(false)
  const added = changes.reduce((n, d) => n + d.added, 0)
  const removed = changes.reduce((n, d) => n + d.removed, 0)
  return (
    <div className="group/turn pb-2 pt-1">
      {changes.length > 0 && (
        <div className="mb-1.5 overflow-hidden rounded-lg border border-line">
          <button type="button" onClick={() => setOpen(!open)} className="flex h-8 w-full items-center gap-2 px-3 text-left text-[12.5px] text-muted hover:text-fg">
            <ChevronRight size={13} className={cn('shrink-0 text-subtle transition-transform', open && 'rotate-90')} />
            <span>{plural(changes.length, 'file')} changed</span>
            <DiffStat added={added} removed={removed} />
          </button>
          {open && (
            <div className="border-t border-line py-1">
              {changes.map((diff) => (
                <button key={diff.path} type="button" onClick={() => openFile(diff.path)} className="flex h-6.5 w-full items-center gap-2 px-3 text-left text-[12px] text-muted hover:bg-hover hover:text-fg">
                  <span className="shrink-0 text-fg">{basename(diff.path)}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-subtle">
                    {root && diff.path.startsWith(root + '/') ? diff.path.slice(root.length + 1) : diff.path}
                  </span>
                  <DiffStat added={diff.added} removed={diff.removed} />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {(answer || !folded) && (
        <div className="flex h-6 items-center gap-1 text-[11.5px] text-subtle">
          {!folded && <span>{item.interrupted ? `Stopped after ${formatDuration(item.durationMs)}` : `Worked for ${formatDuration(item.durationMs)}`}</span>}
          {answer && <CopyButton text={answer} label="Copy response" size={12} className="opacity-0 transition-opacity group-hover/turn:opacity-100" />}
        </div>
      )}
    </div>
  )
}

/** A finished turn's work, folded above its final response. */
function WorkGroup({ item, blocks, ctx }: { item: TurnItem; blocks: Block[]; ctx: TimelineContext }): ReactNode {
  // A turn that just ended starts open so its work visibly folds away.
  const [open, setOpen] = useState(() => !!blocks.length && Date.now() - item.ts < 3000)
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setOpen(false)))
    return () => cancelAnimationFrame(frame)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const label = item.interrupted ? `Stopped after ${formatDuration(item.durationMs)}` : `Worked for ${formatDuration(item.durationMs)}`
  return (
    <div>
      <button
        type="button"
        onClick={blocks.length ? () => setOpen(!open) : undefined}
        disabled={!blocks.length}
        aria-expanded={blocks.length ? open : undefined}
        className={cn('group/work flex h-7 items-center gap-2 text-left text-[13.8px] font-[450] text-muted', blocks.length ? 'hover:text-fg' : 'cursor-default')}
      >
        <span className="flex w-4 shrink-0 justify-center">{item.interrupted ? <CircleStop size={13.5} className="text-subtle" /> : <Clock size={13.5} className="text-subtle" />}</span>
        <span>{label}</span>
        {blocks.length > 0 && <ChevronRight size={13} className={cn('shrink-0 text-subtle opacity-0 transition-all group-hover/work:opacity-100', open && 'rotate-90 opacity-100')} />}
      </button>
      {blocks.length > 0 && (
        <div className="fold" data-open={open} inert={!open}>
          <div className="min-h-0 overflow-hidden"><Blocks blocks={blocks} ctx={ctx} /></div>
        </div>
      )}
    </div>
  )
}

type Block =
  | { type: 'item'; item: Item }
  | { type: 'explore'; items: (ToolItem | ReasoningItem)[]; key: string; scope: string }
  | { type: 'browse'; items: (ToolItem | ReasoningItem)[]; key: string; scope: string }
  | { type: 'turn'; item: TurnItem; changes: FileDiff[]; answer: string; folded: boolean }
  | { type: 'work'; item: TurnItem; blocks: Block[] }
  | { type: 'present'; items: ToolItem[]; key: string }

function buildBlocks(items: Item[], all: Item[], topLevel: boolean, compact = false, fold = true): Block[] {
  const blocks: Block[] = []
  let turnStart = 0
  let turnKey = items[0]?.id ?? 'empty'
  let blockStart = 0
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    if (item.kind === 'user') turnKey = item.id
    const scope = `${item.parentId ?? 'main'}:${turnKey}`
    if (isHiddenAgentMessage(item)) continue
    // The plan shows above the message box instead of in the log.
    if (item.kind === 'tool' && item.tool === 'task') continue
    // Successful deliveries are collected at the bottom of their own turn.
    if (item.kind === 'tool' && item.tool === 'present' && item.status === 'done' && item.meta?.files?.length) continue
    // An empty response placeholder is not a visible boundary between activities.
    if (item.kind === 'assistant' && !item.text.trim()) continue
    if (item.kind === 'reasoning' && !item.streaming && !item.text.trim()) continue
    if (compact && isCompactable(item)) {
      const last = blocks[blocks.length - 1]
      if (last?.type === 'explore') last.items.push(item)
      else blocks.push({ type: 'explore', items: [item], key: item.id, scope })
      continue
    }
    if (isBrowsing(item)) {
      const last = blocks[blocks.length - 1]
      if (last?.type === 'browse') last.items.push(item)
      else if (last?.type === 'explore' && last.items.every((entry) => entry.kind === 'reasoning')) {
        blocks[blocks.length - 1] = { type: 'browse', items: [...last.items, item], key: last.key, scope: last.scope }
      } else blocks.push({ type: 'browse', items: [item], key: item.id, scope })
      continue
    }
    if (item.kind === 'reasoning' || isExplore(item)) {
      const last = blocks[blocks.length - 1]
      if (last?.type === 'explore' || (item.kind === 'reasoning' && last?.type === 'browse')) last.items.push(item)
      else blocks.push({ type: 'explore', items: [item], key: item.id, scope })
      continue
    }
    if (item.kind === 'turn') {
      if (!topLevel) continue
      const slice = items.slice(turnStart, index)
      const ids = new Set(slice.map((i) => i.id))
      // Subagent edits belong to the turn that spawned them.
      const tools = all.filter((i): i is ToolItem => i.kind === 'tool' && (ids.has(i.id) || (!!i.parentId && ids.has(i.parentId))))
      const lastAnswer = [...slice].reverse().find((i): i is AssistantItem => i.kind === 'assistant' && !!i.text.trim())
      // Fold everything before the final response under the turn's duration.
      const answerAt = blocks.findLastIndex((block, at) => at >= blockStart && block.type === 'item' && block.item.kind === 'assistant')
      const workEnd = answerAt === -1 ? blocks.length : answerAt
      if (fold) blocks.splice(blockStart, workEnd - blockStart, { type: 'work', item, blocks: blocks.slice(blockStart, workEnd) })
      const presented = tools.filter((tool) => tool.tool === 'present' && tool.status === 'done' && !!tool.meta?.files?.length)
      if (presented.length) blocks.push({ type: 'present', items: presented, key: item.id })
      blocks.push({ type: 'turn', item, changes: mergeDiffs(tools), answer: lastAnswer?.text ?? '', folded: fold })
      blockStart = blocks.length
      turnStart = index + 1
      continue
    }
    blocks.push({ type: 'item', item })
    if (item.kind === 'user') blockStart = blocks.length
  }
  if (topLevel) {
    const ids = new Set(items.slice(turnStart).map((item) => item.id))
    const presented = all.filter((item): item is ToolItem => item.kind === 'tool' && item.tool === 'present' && item.status === 'done' && !!item.meta?.files?.length && (ids.has(item.id) || (!!item.parentId && ids.has(item.parentId))))
    if (presented.length) blocks.push({ type: 'present', items: presented, key: turnKey })
  }
  return blocks
}

function hasLiveActivity(item: Item): boolean {
  if (isHiddenAgentMessage(item)) return false
  if (item.kind === 'assistant') return !!item.streaming && !!item.text.trim()
  if (item.kind === 'reasoning') return !!item.streaming
  return item.kind === 'tool' && (item.status === 'running' || item.status === 'pending' || item.status === 'awaiting')
}

function Blocks({ blocks, ctx, running = false, stickyMessages = false }: { blocks: Block[]; ctx: TimelineContext; running?: boolean; stickyMessages?: boolean }): ReactNode {
  if (stickyMessages) {
    const turns: { key: string; blocks: Block[] }[] = []
    for (const block of blocks) {
      if (block.type === 'item' && block.item.kind === 'user') turns.push({ key: block.item.id, blocks: [] })
      if (!turns.length) turns.push({ key: 'history', blocks: [] })
      turns[turns.length - 1].blocks.push(block)
    }
    return <>{turns.map((turn) => <section key={turn.key} className="chat-turn relative"><Blocks blocks={turn.blocks} ctx={ctx} running={running && turn === turns[turns.length - 1]} /></section>)}</>
  }
  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === 'present') return (
          <section key={`present:${block.key}`} aria-label="Presented files" className="activity-reveal mb-3 mt-4 w-full space-y-3">
            {block.items.map((item) => <PresentTool key={item.id} item={item} />)}
          </section>
        )
        if (block.type === 'explore' || block.type === 'browse') return <ExploreGroup key={block.key} items={block.items} disclosureKey={`${ctx.chatId}:${block.scope}:${block.key}`} active={running && index === blocks.length - 1} browsing={block.type === 'browse'} ctx={ctx} />
        if (block.type === 'work') return <WorkGroup key={`work:${block.item.id}`} item={block.item} blocks={block.blocks} ctx={ctx} />
        if (block.type === 'turn') return <TurnFooter key={block.item.id} item={block.item} folded={block.folded} changes={block.changes} answer={block.answer} root={ctx.root} />
        const item = block.item
        switch (item.kind) {
          case 'user':
            return <UserMessage key={item.id} item={item} chatId={ctx.chatId} />
          case 'assistant':
            return <AssistantMessage key={item.id} item={item} root={ctx.root} />
          case 'tool':
            return <ToolBlock key={item.id} item={item} ctx={ctx} />
          case 'notice':
            return <Notice key={item.id} item={item} />
          default:
            return null
        }
      })}
    </>
  )
}

/** What the agent is doing right now, in a few words, for the collapsed status line. */
function liveStatus(items: Item[]): string {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (item.kind === 'reasoning' && item.streaming) return 'Thinking'
    if (item.kind === 'assistant' && item.streaming && item.text.trim()) return 'Writing a response'
    if (item.kind === 'tool' && (item.status === 'running' || item.status === 'pending')) {
      const title = toolActivityTitle(item)
      return item.tool === 'bash' ? `Running ${title.charAt(0).toLowerCase()}${title.slice(1)}` : title
    }
  }
  return 'Planning Next Moves'
}

function WorkingIndicator({ since, status = 'Planning Next Moves' }: { since: number; status?: string }): ReactNode {
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  const elapsed = Date.now() - since
  return (
    <div className="activity-reveal flex h-7 items-center gap-2 overflow-hidden text-[13.8px] font-[450]">
      {/* Each new status rolls up into place. */}
      <span key={status} className="status-roll min-w-0 truncate"><span className="shimmer">{status}</span></span>
      {elapsed > 5000 && <span className="font-mono text-[11px] tabular-nums text-subtle">{formatDuration(elapsed)}</span>}
    </div>
  )
}

interface TimelineProps {
  chat: Chat
  items: Item[]
  root: string | null
}

export function AgentTimeline({ chatId, agentId, root }: { chatId: string; agentId: string; root: string | null }): ReactNode {
  const items = useStore((s) => s.items[chatId])
  const compact = useStore((s) => s.settings.toolDensity === 'compact')
  const scroller = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const { ctx, activity, agent } = useMemo(() => {
    const all = items ?? []
    const children = new Map<string, Item[]>()
    const agentNames = new Map<string, string>([['main', 'Main']])
    for (const item of all) {
      if (item.kind === 'tool' && item.tool === 'agent') agentNames.set(item.id, item.title)
      if (item.parentId) children.set(item.parentId, [...(children.get(item.parentId) ?? []), item])
    }
    const ctx: TimelineContext = { chatId, root, children, agentNames, latestTaskId: null, renderBlocks: (list) => <Blocks blocks={buildBlocks(list, all, false, compact)} ctx={ctx} running={agent?.status === 'running'} /> }
    const agent = all.find((item): item is ToolItem => item.id === agentId && item.kind === 'tool')
    return { ctx, agent, activity: children.get(agentId) ?? [] }
  }, [items, chatId, agentId, root, compact])
  useLayoutEffect(() => { if (follow.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight }, [items])
  return (
    <div ref={scroller} onScroll={() => { const el = scroller.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60 }} className="chat-surface h-full overflow-y-auto px-5 py-4">
      <div className="mb-3 flex items-center gap-2 text-[13px] font-medium"><span className={cn(agent?.status === 'running' && 'shimmer')}>{agent?.title ?? 'Subagent'}</span><span className="text-[11px] font-normal text-subtle">{agent?.status === 'done' ? 'Completed' : agent?.status === 'error' ? 'Failed' : 'Working'}</span></div>
      {activity.length ? ctx.renderBlocks(activity) : <div className="text-[12px] text-subtle">{agent?.status === 'running' ? 'Starting…' : 'No recorded activity.'}</div>}
      {agent?.output && agent.status !== 'running' && !activity.some((item) => item.kind === 'assistant' && !!item.text.trim()) && <Markdown text={agent.output} root={root} />}
    </div>
  )
}

export function Timeline({ chat, items, root }: TimelineProps): ReactNode {
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const compact = useStore((s) => s.settings.toolDensity === 'compact')
  const fold = useStore((s) => s.settings.foldWork !== false)
  const expand = useStore((s) => s.settings.expandToolCalls !== false)

  const { top, ctx } = useMemo(() => {
    const children = new Map<string, Item[]>()
    const agentNames = new Map<string, string>([['main', 'Main']])
    const top: Item[] = []
    let latestTaskId: string | null = null
    for (const item of items) {
      if (item.kind === 'tool' && item.tool === 'agent') agentNames.set(item.id, item.title)
      if (item.parentId) {
        const list = children.get(item.parentId)
        if (list) list.push(item)
        else children.set(item.parentId, [item])
      } else {
        top.push(item)
        if (item.kind === 'tool' && item.tool === 'task' && item.meta?.tasks?.length) latestTaskId = item.id
      }
    }
    const ctx: TimelineContext = {
      chatId: chat.id,
      root,
      children,
      agentNames,
      latestTaskId,
      renderBlocks: (list) => <Blocks blocks={buildBlocks(list, items, false, compact)} ctx={ctx} />
    }
    return { top, ctx }
  }, [items, chat.id, root, compact])

  const blocks = useMemo(() => buildBlocks(top, items, true, compact, fold), [top, items, compact, fold])

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    stick.current = near
    setAtBottom(near)
  }, [])

  // Follow new content only while the reader is already at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items, chat.status])

  useLayoutEffect(() => {
    stick.current = true
    setAtBottom(true)
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.id])

  const lastUser = [...top].reverse().find((i) => i.kind === 'user')
  const hasActivity = top.slice(lastUser ? top.indexOf(lastUser) + 1 : 0).some(hasLiveActivity)

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-[780px] px-6 pb-10 pt-4">
          <Blocks blocks={blocks} ctx={ctx} running={chat.status === 'running'} stickyMessages />
          {chat.reverted && chat.status !== 'running' && <RevertedEditor key={chat.reverted.text} chat={chat} />}
          {chat.status === 'running' && (!expand ? <WorkingIndicator since={lastUser?.ts ?? Date.now()} status={liveStatus(top.slice(lastUser ? top.indexOf(lastUser) + 1 : 0))} /> : !hasActivity && <WorkingIndicator since={lastUser?.ts ?? Date.now()} />)}
        </div>
      </div>
      {!atBottom && (
        <button
          type="button"
          onClick={() => {
            const el = scroller.current
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
          }}
          className="fade-in absolute bottom-3 left-1/2 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full bg-elev text-muted shadow-pop hover:text-fg"
          title="Jump to latest"
        >
          <ArrowDown size={14} />
        </button>
      )}
    </div>
  )
}
