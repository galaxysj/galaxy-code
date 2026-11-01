import { Bot, Diff, LayoutList, SquareTerminal } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import type { Chat, ToolItem } from '@shared/types'
import { useStore } from '../store'
import { IconButton, Spinner, TabFavicon } from './ui'

const LIVE = ['pending', 'running', 'awaiting']

export const OVERVIEW_WIDTH = 272
/** The widest the timeline and composer get. The chat never resizes for the card, so this decides whether it can slide aside. */
export const CHAT_COLUMN_WIDTH = 780

function CardRow({ icon, label, detail, onClick }: { icon: ReactNode; label: string; detail?: ReactNode; onClick: () => void }): ReactNode {
  return (
    <button type="button" onClick={onClick} className="flex h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-fg hover:bg-hover">
      <span className="flex w-4 shrink-0 justify-center text-subtle">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail}
    </button>
  )
}

function CardSection({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <div className="mt-2">
      <div className="px-2.5 pb-1 text-[11px] font-medium text-subtle">{title}</div>
      {children}
    </div>
  )
}

export function OverviewButton(): ReactNode {
  const open = useStore((s) => s.overviewOpen)
  return (
    <IconButton data-overview-toggle label={open ? 'Hide chat overview' : 'Show chat overview'} active={open} className="no-drag shrink-0" onClick={() => useStore.setState({ overviewOpen: !open })}>
      <LayoutList size={15} />
    </IconButton>
  )
}

/** The card in the top right corner. `docked` means the chat has slid out from under it; otherwise it is a popup over the chat, which a click outside closes. */
export function OverviewCard({ chat, right, docked }: { chat: Chat; right: number; docked: boolean }): ReactNode {
  const card = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (docked) return
    const close = (): void => useStore.setState({ overviewOpen: false })
    const outside = (event: MouseEvent): void => {
      const node = event.target as HTMLElement
      if (!card.current?.contains(node) && !node.closest('[data-overview-toggle]')) close()
    }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
    window.addEventListener('mousedown', outside)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('mousedown', outside)
      window.removeEventListener('keydown', escape)
    }
  }, [docked])
  return (
    <div ref={card} className="pop-in fixed top-[60px] z-[60] max-h-[70vh] overflow-y-auto rounded-2xl border border-line bg-elev shadow-pop" style={{ right, width: OVERVIEW_WIDTH - 7 }}>
      <SessionOverview chat={chat} />
    </div>
  )
}

/** What the chat has going on: its changes, tabs and subagents. */
export function SessionOverview({ chat }: { chat: Chat }): ReactNode {
  const project = useStore((s) => s.projects.find((entry) => entry.id === chat.projectId))
  const tabs = useStore((s) => s.panelTabs)
  const browserStates = useStore((s) => s.browserStates)
  const items = useStore((s) => s.items[chat.id])
  const setPanel = useStore((s) => s.setPanel)
  const createPanelTab = useStore((s) => s.createPanelTab)
  const openAgent = useStore((s) => s.openAgent)

  const root = chat.worktree?.path ?? project?.path ?? null
  const browsers = tabs.filter((tab) => tab.type === 'browser')
  const terminals = tabs.filter((tab) => tab.type === 'terminal')
  const agents = (items ?? []).filter((item): item is ToolItem => item.kind === 'tool' && item.tool === 'agent' && !item.parentId)
  return (
    <div className="p-2">
      <div className="truncate px-2.5 pb-1 pt-1 text-[13px] text-muted" title={root ?? undefined}>
        {project?.name ?? 'No project'}{chat.worktree ? ` · ${chat.worktree.branch}` : ''}
      </div>
      {root && <CardRow icon={<Diff size={14} />} label="Changes" onClick={() => void createPanelTab('review', root)} />}
      {browsers.length > 0 && (
        <CardSection title="Browser tabs">
          {browsers.map((tab) => <CardRow key={tab.id} icon={<TabFavicon src={browserStates[tab.id]?.favicon} />} label={tab.customTitle ?? (browserStates[tab.id]?.title || tab.title)} onClick={() => setPanel(true, tab.id)} />)}
        </CardSection>
      )}
      {terminals.length > 0 && (
        <CardSection title="Terminals">
          {terminals.map((tab) => <CardRow key={tab.id} icon={<SquareTerminal size={14} />} label={tab.customTitle ?? tab.title} onClick={() => setPanel(true, tab.id)} />)}
        </CardSection>
      )}
      {agents.length > 0 && (
        <CardSection title="Subagents">
          {agents.map((agent) => <CardRow key={agent.id} icon={<Bot size={14} />} label={agent.title} detail={LIVE.includes(agent.status) ? <Spinner size={12} /> : null} onClick={() => openAgent(chat.id, agent.id, agent.title, root)} />)}
        </CardSection>
      )}
    </div>
  )
}
