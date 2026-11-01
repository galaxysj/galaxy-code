import { CircleAlert, PanelLeft, PanelRight, SquarePen } from 'lucide-react'
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { hasModelKey } from '@shared/catalog'
import type { Chat } from '@shared/types'
import { cn, formatTokens, tildify } from './lib/utils'
import { useActiveChat, useStore } from './store'
import { Composer } from './components/Composer'
import { SettingsPage } from './components/Settings'
import { AntigravityConsent } from './components/AntigravityConsent'
import { AttachmentPreview } from './components/AttachmentPreview'
import { ComputerPip } from './components/ComputerPip'
import { Resizer, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from './components/Resizer'
import { CHAT_COLUMN_WIDTH, OverviewButton, OverviewCard, OVERVIEW_WIDTH } from './components/SessionCard'
import { Sidebar } from './components/Sidebar'
import { SidePanel } from './components/SidePanel'
import { ErrorDialog, Timeline } from './components/timeline/Timeline'
import { IconButton, Spinner } from './components/ui'

function useTheme(): void {
  const theme = useStore((s) => s.settings.theme)
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const dark = theme === 'dark' || (theme !== 'light' && media.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
}

function ChatHeader({ chat, sidebarOpen }: { chat: Chat | null; sidebarOpen: boolean }): ReactNode {
  const platform = useStore((s) => s.platform)
  const panelOpen = useStore((s) => s.panelOpen)
  const setPanel = useStore((s) => s.setPanel)
  const newChat = useStore((s) => s.newChat)
  const project = useStore((s) => s.projects.find((p) => p.id === (chat ? chat.projectId : s.draft.projectId)))
  const homeDir = useStore((s) => s.homeDir)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')

  const commit = (): void => {
    setEditing(false)
    if (chat && title.trim() && title.trim() !== chat.title) void window.galaxy.chats.update(chat.id, { title: title.trim() })
  }

  return (
    <div className={cn('relative flex h-[46px] shrink-0 items-center gap-1 pr-2', sidebarOpen ? 'pl-4' : platform === 'darwin' ? 'pl-[84px]' : 'pl-2')}>
      {!sidebarOpen && (
        <>
          <IconButton label="Show sidebar" onClick={() => useStore.setState({ sidebarOpen: true })}>
            <PanelLeft size={15} />
          </IconButton>
          <IconButton label="New chat" onClick={() => newChat()}>
            <SquarePen size={14.5} />
          </IconButton>
        </>
      )}
      <div className="drag relative z-0 flex h-full min-w-0 flex-1 items-center gap-2 pl-1">
        {chat &&
          (editing ? (
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commit()
                if (event.key === 'Escape') setEditing(false)
              }}
              className="no-drag h-6 w-[320px] max-w-full rounded border border-line-strong bg-inset px-1.5 text-[13px] font-medium"
            />
          ) : (
            <button
              type="button"
              className="no-drag min-w-0 truncate text-[13px] font-medium text-fg"
              title="Double-click to rename"
              onDoubleClick={() => {
                setTitle(chat.title)
                setEditing(true)
              }}
            >
              {chat.title}
            </button>
          ))}
        {chat && project && !editing && (
          <span className="min-w-0 shrink truncate text-[12px] text-subtle" title={chat.worktree?.path ?? project.path}>
            {project.name}
            {chat.worktree ? ` · ${chat.worktree.branch}` : ''}
          </span>
        )}
        {chat && !project && !editing && chat.projectId === null && <span className="shrink-0 text-[12px] text-subtle">No project</span>}
      </div>
      {chat && chat.usage.contextTokens > 0 && (
        <span
          className="no-drag mr-1 shrink-0 font-mono text-[11px] tabular-nums text-subtle"
          title={`Context in use: ${chat.usage.contextTokens.toLocaleString()} tokens\nTotal input: ${chat.usage.inputTokens.toLocaleString()}\nTotal output: ${chat.usage.outputTokens.toLocaleString()}${chat.usage.cost > 0 ? `\nCost: $${chat.usage.cost.toFixed(4)}` : ''}${project ? `\n${tildify(chat.worktree?.path ?? project.path, homeDir)}` : ''}`}
        >
          {formatTokens(chat.usage.contextTokens)}
          {chat.usage.cost > 0 ? ` · $${chat.usage.cost.toFixed(chat.usage.cost < 1 ? 3 : 2)}` : ''}
        </span>
      )}
      {chat && <OverviewButton />}
      <IconButton label={panelOpen ? 'Hide side panel' : 'Show side panel'} active={panelOpen} onClick={() => setPanel(!panelOpen)}>
        <PanelRight size={15} />
      </IconButton>
    </div>
  )
}

function Welcome(): ReactNode {
  const secrets = useStore((s) => s.secrets)
  const settings = useStore((s) => s.settings)
  const draft = useStore((s) => s.draft)
  const models = useStore((s) => s.models)
  const project = useStore((s) => s.projects.find((p) => p.id === s.draft.projectId))
  const model = models.find((m) => m.key === draft.modelKey)
  const needsKey = model?.subscription === 'Default' && !hasModelKey(secrets, settings, model.id)
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center pb-[12vh]">
      <h1 className="mb-6 text-center text-[24px] font-semibold tracking-[-0.02em] text-fg">
        {project ? `What should we do in ${project.name}?` : 'What should we work on?'}
      </h1>
      <Composer centered />
      <div className="mx-auto mt-3 h-8 w-full max-w-[780px] px-6">
        {needsKey && (
          <button
            type="button"
            onClick={() => useStore.setState({ settingsOpen: 'providers' })}
            className="flex h-8 w-full items-center gap-2 rounded-lg border border-warn/30 bg-warn/8 px-3 text-left text-[12.5px] text-fg hover:bg-warn/12"
          >
            <CircleAlert size={13.5} className="shrink-0 text-warn" />
            <span className="min-w-0 flex-1 truncate">{model?.name} runs on OpenRouter. Add an API key, or pick a model from a connected AI account.</span>
            <span className="shrink-0 text-[12px] text-muted">Open settings</span>
          </button>
        )}
      </div>
    </div>
  )
}

const EMPTY_ITEMS: never[] = []
const MIN_PANEL_WIDTH = 360

/** Closes the error dialog and hands the error to the agent in the current chat. */
function fixWithAgent(message: string, close: () => void): void {
  close()
  void useStore.getState().send(`I hit this error. Please investigate and fix it:\n\n${message}`, [])
}

export function App(): ReactNode {
  const ready = useStore((s) => s.ready)
  const init = useStore((s) => s.init)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const panelOpen = useStore((s) => s.panelOpen)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const antigravityConsent = useStore((s) => s.antigravityConsent)
  const attachmentPreview = useStore((s) => s.attachmentPreview)
  const toast = useStore((s) => s.toast)
  const gitError = useStore((s) => s.gitError)
  const appError = useStore((s) => s.appError)
  const updateSettings = useStore((s) => s.updateSettings)
  const savedSidebar = useStore((s) => s.settings.sidebarWidth)
  const savedPanel = useStore((s) => s.settings.panelWidth)
  const chat = useActiveChat()
  const overviewOpen = useStore((s) => s.overviewOpen) && !!chat
  const items = useStore((s) => (s.activeChatId ? s.items[s.activeChatId] : undefined))
  const project = useStore((s) => s.projects.find((p) => p.id === (chat ? chat.projectId : s.draft.projectId)))
  const [sidebarWidth, setSidebarWidth] = useState(272)
  const [panelWidth, setPanelWidth] = useState(560)
  const [resizing, setResizing] = useState<'sidebar' | 'panel' | null>(null)
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight })
  useTheme()

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    let frame = 0
    const resize = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setViewport({ width: window.innerWidth, height: window.innerHeight }))
    }
    window.addEventListener('resize', resize)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', resize) }
  }, [])

  const availablePanelWidth = viewport.width - (sidebarOpen ? sidebarWidth : 0) - 420
  useEffect(() => {
    // Only a lack of width closes the panel; a short window keeps it open.
    if (panelOpen && availablePanelWidth < MIN_PANEL_WIDTH) useStore.getState().setPanel(false)
  }, [panelOpen, availablePanelWidth])

  useEffect(() => {
    if (savedSidebar) setSidebarWidth(savedSidebar)
    if (savedPanel) setPanelWidth(savedPanel)
  }, [savedSidebar, savedPanel])

  // Reading a chat clears its unread mark, including when the window regains focus.
  useEffect(() => {
    const onFocus = (): void => {
      const state = useStore.getState()
      void state.refreshAccounts()
      const id = state.activeChatId
      if (id && state.chats[id]?.unread) void window.galaxy.chats.markRead(id)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const maxPanel = useCallback(() => Math.max(MIN_PANEL_WIDTH, availablePanelWidth), [availablePanelWidth])
  const panelSpace = panelOpen ? Math.min(panelWidth, maxPanel()) : 0
  // The chat keeps its width and only slides left, so the card needs that much room beside the column.
  const besideColumn = viewport.width - (sidebarOpen ? sidebarWidth : 0) - panelSpace - CHAT_COLUMN_WIDTH
  const overviewDocked = overviewOpen && besideColumn >= OVERVIEW_WIDTH
  const chatShift = overviewDocked ? Math.max(0, OVERVIEW_WIDTH - besideColumn / 2) : 0

  if (!ready) {
    return (
      <div className="drag flex h-full items-center justify-center bg-bg">
        <Spinner size={18} className="text-subtle" />
      </div>
    )
  }

  const root = chat?.worktree?.path ?? project?.path ?? null

  return (
    <div className="app-shell relative flex h-full text-fg">
      <aside aria-hidden={!sidebarOpen} inert={!sidebarOpen} className={cn('sidebar-surface animated-pane relative shrink-0 overflow-hidden', resizing === 'sidebar' && 'pane-resizing', settingsOpen && 'invisible')} style={{ width: sidebarOpen ? sidebarWidth : 0, opacity: sidebarOpen ? 1 : 0, pointerEvents: sidebarOpen ? 'auto' : 'none' }}>
        <div className="animated-pane-content absolute inset-y-0 left-0" style={{ width: sidebarWidth, transform: sidebarOpen ? 'translateX(0)' : 'translateX(-16px)' }}>
          <Sidebar />
        </div>
      </aside>
      {sidebarOpen && !settingsOpen && <Resizer gutter={sidebarWidth} width={sidebarWidth} min={SIDEBAR_MIN_WIDTH} max={SIDEBAR_MAX_WIDTH} direction={1} onChange={setSidebarWidth} onStart={() => setResizing('sidebar')} onEnd={() => setResizing(null)} onCommit={(width) => void updateSettings({ sidebarWidth: Math.round(width) })} />}
      <div className={cn('workspace-surface flex min-w-0 flex-1 overflow-hidden', settingsOpen && 'invisible')}>
        <main className={cn('chat-surface flex min-w-[380px] flex-1 flex-col overflow-hidden', (sidebarOpen || panelOpen) && 'm-1.5 rounded-xl shadow-[0_0_0_1px_var(--border)]')}>
          <ChatHeader chat={chat} sidebarOpen={sidebarOpen} />
          {chat ? (
            <div className="flex min-h-0 flex-1 flex-col" style={{ '--chat-shift': `${chatShift}px` } as CSSProperties}>
              <Timeline chat={chat} items={items ?? EMPTY_ITEMS} root={root} />
              <Composer />
            </div>
          ) : (
            <Welcome />
          )}
        </main>
        <aside aria-hidden={!panelOpen} inert={!panelOpen} className={cn('animated-pane relative shrink-0 overflow-hidden', resizing === 'panel' && 'pane-resizing')} style={{ width: panelOpen ? Math.min(panelWidth, maxPanel()) : 0, opacity: panelOpen ? 1 : 0, pointerEvents: panelOpen ? 'auto' : 'none' }}>
          <Resizer width={Math.min(panelWidth, maxPanel())} min={MIN_PANEL_WIDTH} max={maxPanel()} direction={-1} onChange={setPanelWidth} onStart={() => setResizing('panel')} onEnd={() => setResizing(null)} onCollapse={() => { setResizing(null); useStore.getState().setPanel(false) }} onExpand={() => { setResizing(null); if (useStore.getState().panelTabs.length) useStore.setState({ panelOpen: true }) }} onCommit={(width) => void updateSettings({ panelWidth: Math.round(width) })} />
          <div className="animated-pane-content absolute inset-y-1.5 left-px right-1.5 overflow-hidden rounded-xl shadow-[inset_0_0_0_1px_var(--border)]" style={{ transform: panelOpen ? 'translateX(0)' : 'translateX(16px)' }}>
            <SidePanel root={root} covered={settingsOpen !== null || antigravityConsent !== null || attachmentPreview !== null || !panelOpen} />
          </div>
        </aside>
      </div>
      <SettingsPage />
      {gitError && <ErrorDialog title="Instant commit failed" message={gitError} onClose={() => useStore.setState({ gitError: null })} onFix={() => fixWithAgent(gitError, () => useStore.setState({ gitError: null }))} />}
      {appError && <ErrorDialog title="Error" message={appError} onClose={() => useStore.setState({ appError: null })} onFix={() => fixWithAgent(appError, () => useStore.setState({ appError: null }))} />}
      {antigravityConsent && <AntigravityConsent requestId={antigravityConsent} />}
      {attachmentPreview && <AttachmentPreview key={attachmentPreview.id} file={attachmentPreview} />}
      <ComputerPip />
      {chat && overviewOpen && <OverviewCard chat={chat} right={panelSpace + 14} docked={overviewDocked} />}
      {toast && (
        <div
          key={toast.id}
          className={cn(
            'pop-in pointer-events-none fixed bottom-5 left-5 z-[60] max-w-[420px] rounded-lg bg-elev px-3.5 py-2.5 text-[12.5px] shadow-pop',
            toast.tone === 'error' ? 'text-danger' : 'text-fg'
          )}
        >
          {toast.text}
        </div>
      )}
    </div>
  )
}
