import { ArrowDown, ChevronRight, CircleAlert, File as FileIcon, Info } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AssistantItem, Chat, FileDiff, Item, NoticeItem, ReasoningItem, ToolItem, TurnItem, UserItem } from '@shared/types'
import { basename, cn, formatBytes, formatDuration, plural } from '../../lib/utils'
import { useStore } from '../../store'
import { DiffStat } from '../DiffView'
import { Markdown } from '../Markdown'
import { CopyButton } from '../ui'
import { ExploreGroup, isBrowsing, isExplore, isHiddenAgentMessage, PresentTool, ToolBlock, type TimelineContext } from './Tools'

const UserMessage = memo(function UserMessage({ item }: { item: UserItem }): ReactNode {
  const openFile = useStore((s) => s.openFile)
  return (
    <div className="group/user flex flex-col items-end pb-1 pt-5 first:pt-0">
      {item.attachments.length > 0 && (
        <div className="mb-1.5 flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {item.attachments.map((file) =>
            file.preview ? (
              <button key={file.id} type="button" onClick={() => openFile(file.path)} className="h-16 w-16 overflow-hidden rounded-lg border border-line" title={file.name}>
                <img src={file.preview} alt="" className="h-full w-full object-cover" draggable={false} />
              </button>
            ) : (
              <button key={file.id} type="button" onClick={() => openFile(file.path)} className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-elev px-2 text-[12px] text-muted hover:text-fg" title={file.path}>
                <FileIcon size={12.5} />
                <span className="max-w-[160px] truncate">{file.name}</span>
                <span className="text-subtle">{formatBytes(file.size)}</span>
              </button>
            )
          )}
        </div>
      )}
      {item.text && (
        <div className="selectable max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-elev px-3.5 py-2 text-[16.2px] leading-[1.55] text-fg shadow-[0_0_0_1px_var(--border)]">
          {item.text}
        </div>
      )}
      <div className="mt-0.5 flex h-5 items-center opacity-0 transition-opacity group-hover/user:opacity-100">
        <CopyButton text={item.text} label="Copy message" size={12} />
      </div>
    </div>
  )
})

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

function TurnFooter({ changes, answer, root }: { changes: FileDiff[]; answer: string; root: string | null }): ReactNode {
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
      {answer && (
        <div className="flex h-6 items-center">
          <CopyButton text={answer} label="Copy response" size={12} className="opacity-0 transition-opacity group-hover/turn:opacity-100" />
        </div>
      )}
    </div>
  )
}

/** A finished turn's work, folded above its final response. */
function WorkGroup({ item, blocks, ctx }: { item: TurnItem; blocks: Block[]; ctx: TimelineContext }): ReactNode {
  const [open, setOpen] = useState(false)
  const label = item.interrupted ? `Stopped after ${formatDuration(item.durationMs)}` : `Worked for ${formatDuration(item.durationMs)}`
  const space = label.indexOf(' ')
  return (
    <div>
      <button
        type="button"
        onClick={blocks.length ? () => setOpen(!open) : undefined}
        disabled={!blocks.length}
        aria-expanded={blocks.length ? open : undefined}
        className={cn('group/work flex h-7 items-center gap-1.5 text-left text-[13.8px] text-muted', blocks.length ? 'hover:text-fg' : 'cursor-default')}
      >
        <span><span className="text-fg">{label.slice(0, space)}</span>{label.slice(space)}</span>
        {blocks.length > 0 && <ChevronRight size={13} className={cn('shrink-0 text-subtle opacity-0 transition-all group-hover/work:opacity-100', open && 'rotate-90 opacity-100')} />}
      </button>
      {open && <div className="activity-reveal"><Blocks blocks={blocks} ctx={ctx} /></div>}
    </div>
  )
}

type Block =
  | { type: 'item'; item: Item }
  | { type: 'explore'; items: (ToolItem | ReasoningItem)[]; key: string; scope: string }
  | { type: 'browse'; items: (ToolItem | ReasoningItem)[]; key: string; scope: string }
  | { type: 'turn'; item: TurnItem; changes: FileDiff[]; answer: string }
  | { type: 'work'; item: TurnItem; blocks: Block[] }

function buildBlocks(items: Item[], all: Item[], topLevel: boolean): Block[] {
  const blocks: Block[] = []
  let turnStart = 0
  let turnKey = items[0]?.id ?? 'empty'
  let blockStart = 0
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    if (item.kind === 'user') turnKey = item.id
    const scope = `${item.parentId ?? 'main'}:${turnKey}`
    if (isHiddenAgentMessage(item)) continue
    // Successful deliveries are shown together at the bottom once the run has ended.
    if (item.kind === 'tool' && item.tool === 'present' && item.status === 'done' && item.meta?.files?.length) continue
    // An empty response placeholder is not a visible boundary between activities.
    if (item.kind === 'assistant' && !item.text.trim()) continue
    if (item.kind === 'reasoning' && !item.streaming && !item.text.trim()) continue
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
      blocks.splice(blockStart, workEnd - blockStart, { type: 'work', item, blocks: blocks.slice(blockStart, workEnd) })
      blocks.push({ type: 'turn', item, changes: mergeDiffs(tools), answer: lastAnswer?.text ?? '' })
      blockStart = blocks.length
      turnStart = index + 1
      continue
    }
    blocks.push({ type: 'item', item })
    if (item.kind === 'user') blockStart = blocks.length
  }
  return blocks
}

function hasLiveActivity(item: Item): boolean {
  if (isHiddenAgentMessage(item)) return false
  if (item.kind === 'assistant') return !!item.streaming && !!item.text.trim()
  if (item.kind === 'reasoning') return !!item.streaming
  return item.kind === 'tool' && (item.status === 'running' || item.status === 'pending' || item.status === 'awaiting')
}

function Blocks({ blocks, ctx, running = false }: { blocks: Block[]; ctx: TimelineContext; running?: boolean }): ReactNode {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === 'explore' || block.type === 'browse') return <ExploreGroup key={block.key} items={block.items} disclosureKey={`${ctx.chatId}:${block.scope}:${block.key}`} active={running && index === blocks.length - 1} browsing={block.type === 'browse'} ctx={ctx} />
        if (block.type === 'work') return <WorkGroup key={`work:${block.item.id}`} item={block.item} blocks={block.blocks} ctx={ctx} />
        if (block.type === 'turn') return <TurnFooter key={block.item.id} changes={block.changes} answer={block.answer} root={ctx.root} />
        const item = block.item
        switch (item.kind) {
          case 'user':
            return <UserMessage key={item.id} item={item} />
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

function WorkingIndicator({ since }: { since: number }): ReactNode {
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  const elapsed = Date.now() - since
  return (
    <div className="activity-reveal flex h-7 items-center gap-2 text-[12.5px]">
      <span className="shimmer">Planning Next Moves</span>
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
    const ctx: TimelineContext = { chatId, root, children, agentNames, latestTaskId: null, renderBlocks: (list) => <Blocks blocks={buildBlocks(list, all, false)} ctx={ctx} running={agent?.status === 'running'} /> }
    const agent = all.find((item): item is ToolItem => item.id === agentId && item.kind === 'tool')
    return { ctx, agent, activity: children.get(agentId) ?? [] }
  }, [items, chatId, agentId, root])
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
      renderBlocks: (list) => <Blocks blocks={buildBlocks(list, items, false)} ctx={ctx} />
    }
    return { top, ctx }
  }, [items, chat.id, root])

  const blocks = useMemo(() => buildBlocks(top, items, true), [top, items])
  const presented = useMemo(() => items.filter((item): item is ToolItem => item.kind === 'tool' && item.tool === 'present' && item.status === 'done' && !!item.meta?.files?.length), [items])

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
  const lastBlock = blocks[blocks.length - 1]
  const hasActivity = lastBlock?.type === 'explore' || lastBlock?.type === 'browse' || top.slice(lastUser ? top.indexOf(lastUser) + 1 : 0).some(hasLiveActivity)

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-[780px] px-6 pb-10 pt-4">
          <Blocks blocks={blocks} ctx={ctx} running={chat.status === 'running'} />
          {chat.status === 'running' && !hasActivity && <WorkingIndicator since={lastUser?.ts ?? Date.now()} />}
          {(chat.status === 'idle' || chat.status === 'error') && presented.length > 0 && (
            <section aria-label="Presented files" className="activity-reveal mt-4 w-full space-y-3">
              {presented.map((item) => <PresentTool key={item.id} item={item} />)}
            </section>
          )}
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
