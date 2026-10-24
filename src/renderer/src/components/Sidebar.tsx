import {
  ChevronRight,
  Ellipsis,
  Folder,
  FolderGit2,
  FolderOpen,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  Settings as SettingsIcon,
  SquarePen,
  Trash2,
  X
} from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Chat, Project } from '@shared/types'
import { cn, relativeTime } from '../lib/utils'
import { useStore } from '../store'
import { IconButton, MenuItem, MenuSeparator, Popover, Spinner } from './ui'

const PAGE = 6

function StatusDot({ chat }: { chat: Chat }): ReactNode {
  if (chat.status === 'running') return <Spinner size={11} className="text-muted" />
  if (chat.status === 'awaiting') return <span className="h-[7px] w-[7px] rounded-full bg-warn" title="Waiting for you" />
  if (chat.unread) return <span className="h-[7px] w-[7px] rounded-full bg-link" title="Unread" />
  if (chat.status === 'error') return <span className="h-[7px] w-[7px] rounded-full bg-danger/80" title="Ended with an error" />
  return null
}

const ChatRow = memo(function ChatRow({ chat, active, now }: { chat: Chat; active: boolean; now: number }): ReactNode {
  const selectChat = useStore((s) => s.selectChat)
  const anchor = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(chat.title)

  const commit = (): void => {
    setRenaming(false)
    if (title.trim() && title.trim() !== chat.title) void window.galaxy.chats.update(chat.id, { title: title.trim() })
    else setTitle(chat.title)
  }

  return (
    <div
      className={cn(
        'group/chat relative flex h-[30px] items-center rounded-md pl-2 pr-1 text-[12.5px] transition-colors',
        active ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg'
      )}
    >
      {renaming ? (
        <input
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') {
              setTitle(chat.title)
              setRenaming(false)
            }
          }}
          className="h-6 min-w-0 flex-1 rounded border border-line-strong bg-inset px-1.5 text-[12.5px] text-fg"
        />
      ) : (
        <button type="button" onClick={() => selectChat(chat.id)} onDoubleClick={() => setRenaming(true)} className="flex h-full min-w-0 flex-1 items-center gap-2 text-left">
          <span className={cn('min-w-0 flex-1 truncate', chat.unread && !active && 'font-medium text-fg')}>{chat.title}</span>
        </button>
      )}
      <span className="ml-1.5 flex h-5 min-w-[22px] shrink-0 items-center justify-end">
        <span className={cn('flex items-center', (menu || renaming) && 'hidden', 'group-hover/chat:hidden')}>
          {chat.status !== 'idle' || chat.unread ? <StatusDot chat={chat} /> : <span className="text-[11px] tabular-nums text-subtle">{relativeTime(chat.updatedAt, now)}</span>}
        </span>
        <button
          ref={anchor}
          type="button"
          title="More"
          onClick={() => setMenu(!menu)}
          className={cn('h-5 w-5 items-center justify-center rounded text-muted hover:bg-active hover:text-fg', menu ? 'flex' : 'hidden group-hover/chat:flex')}
        >
          <Ellipsis size={14} />
        </button>
      </span>
      <Popover open={menu} onClose={() => setMenu(false)} anchor={anchor} placement="bottom-start" className="w-[170px] p-1">
        <MenuItem
          icon={<Pencil size={13} />}
          label="Rename"
          onClick={() => {
            setMenu(false)
            setTitle(chat.title)
            setRenaming(true)
          }}
        />
        <MenuItem
          icon={<Trash2 size={13} />}
          label="Delete"
          danger
          onClick={() => {
            setMenu(false)
            void window.galaxy.chats.remove(chat.id)
          }}
        />
      </Popover>
    </div>
  )
})

function ChatList({ chats, activeId, now }: { chats: Chat[]; activeId: string | null; now: number }): ReactNode {
  const [limit, setLimit] = useState(PAGE)
  // Never hide the open chat behind "Show more".
  const activeIndex = chats.findIndex((c) => c.id === activeId)
  const count = Math.max(limit, activeIndex + 1)
  const shown = chats.slice(0, count)
  return (
    <>
      {shown.map((chat) => (
        <ChatRow key={chat.id} chat={chat} active={chat.id === activeId} now={now} />
      ))}
      {chats.length > count && (
        <button type="button" onClick={() => setLimit(limit + 12)} className="flex h-6.5 w-full items-center px-2 text-[11.5px] text-subtle hover:text-muted">
          Show {Math.min(12, chats.length - count)} more
        </button>
      )}
    </>
  )
}

function ProjectGroup({ project, chats, activeId, now }: { project: Project; chats: Chat[]; activeId: string | null; now: number }): ReactNode {
  const collapsed = useStore((s) => s.settings.collapsedProjects.includes(project.id))
  const updateSettings = useStore((s) => s.updateSettings)
  const newChat = useStore((s) => s.newChat)
  const draftProject = useStore((s) => (s.activeChatId === null ? s.draft.projectId : null))
  const anchor = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(project.name)
  const [confirming, setConfirming] = useState(false)

  const toggle = (): void => {
    const current = useStore.getState().settings.collapsedProjects
    void updateSettings({ collapsedProjects: collapsed ? current.filter((id) => id !== project.id) : [...current, project.id] })
  }
  const commit = (): void => {
    setRenaming(false)
    if (name.trim() && name.trim() !== project.name) void window.galaxy.projects.rename(project.id, name.trim())
    else setName(project.name)
  }
  const Icon = project.isGit ? FolderGit2 : collapsed ? Folder : FolderOpen
  // A collapsed project still has to show that something inside needs attention.
  const attention = collapsed ? (chats.find((c) => c.status === 'awaiting') ?? chats.find((c) => c.status === 'running') ?? chats.find((c) => c.unread)) : undefined

  return (
    <div className="mb-2">
      <div className={cn('group/proj flex h-[30px] items-center rounded-md pl-1.5 pr-1 text-[12.5px] text-fg', draftProject === project.id && 'bg-hover')}>
        {renaming ? (
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit()
              if (event.key === 'Escape') {
                setName(project.name)
                setRenaming(false)
              }
            }}
            className="ml-5 h-6 min-w-0 flex-1 rounded border border-line-strong bg-inset px-1.5 text-[12.5px]"
          />
        ) : (
          <button type="button" onClick={toggle} className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left" title={project.path}>
            <span className="relative flex h-4 w-4 shrink-0 items-center justify-center text-muted">
              <Icon size={13.5} className="group-hover/proj:opacity-0" />
              <ChevronRight size={13} className={cn('absolute opacity-0 transition-transform group-hover/proj:opacity-100', !collapsed && 'rotate-90')} />
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
          </button>
        )}
        {attention && !menu && (
          <span className="mr-1.5 flex shrink-0 items-center group-hover/proj:hidden">
            <StatusDot chat={attention} />
          </span>
        )}
        <div className={cn('shrink-0 items-center', menu ? 'flex' : 'hidden group-hover/proj:flex')}>
          <button ref={anchor} type="button" title="Project options" onClick={() => setMenu(!menu)} className="flex h-5 w-5 items-center justify-center rounded text-muted hover:bg-active hover:text-fg">
            <Ellipsis size={14} />
          </button>
          <button type="button" title={`New chat in ${project.name}`} onClick={() => newChat(project.id)} className="flex h-5 w-5 items-center justify-center rounded text-muted hover:bg-active hover:text-fg">
            <Plus size={14} />
          </button>
        </div>
        <Popover
          open={menu}
          onClose={() => {
            setMenu(false)
            setConfirming(false)
          }}
          anchor={anchor}
          placement="bottom-start"
          className="w-[210px] p-1"
        >
          <MenuItem
            icon={<Pencil size={13} />}
            label="Rename"
            onClick={() => {
              setMenu(false)
              setRenaming(true)
            }}
          />
          <MenuItem
            icon={<FolderOpen size={13} />}
            label="Show in folder"
            onClick={() => {
              setMenu(false)
              void window.galaxy.projects.reveal(project.id)
            }}
          />
          <MenuSeparator />
          <MenuItem
            icon={<Trash2 size={13} />}
            label={confirming ? `Remove with ${chats.length} chat${chats.length === 1 ? '' : 's'}?` : 'Remove project'}
            hint={confirming ? 'Confirm' : undefined}
            danger
            onClick={() => {
              if (!confirming && chats.length > 0) {
                setConfirming(true)
                return
              }
              setMenu(false)
              void window.galaxy.projects.remove(project.id)
            }}
          />
          <div className="px-2 pb-1 pt-0.5 text-[11px] leading-snug text-subtle">Files on disk are kept.</div>
        </Popover>
      </div>
      {!collapsed && (
        <div className="ml-[11px] border-l border-line pl-[5px]">
          {chats.length === 0 ? (
            <button type="button" onClick={() => newChat(project.id)} className="flex h-[28px] w-full items-center px-2 text-[12px] text-subtle hover:text-muted">
              No chats yet
            </button>
          ) : (
            <ChatList chats={chats} activeId={activeId} now={now} />
          )}
        </div>
      )}
    </div>
  )
}

export function Sidebar(): ReactNode {
  const projects = useStore((s) => s.projects)
  const chatMap = useStore((s) => s.chats)
  const activeId = useStore((s) => s.activeChatId)
  const newChat = useStore((s) => s.newChat)
  const platform = useStore((s) => s.platform)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  const { byProject, recents } = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const all = Object.values(chatMap)
      .filter((chat) => !needle || chat.title.toLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const known = new Set(projects.map((p) => p.id))
    const byProject = new Map<string, Chat[]>()
    const recents: Chat[] = []
    for (const chat of all) {
      if (chat.projectId && known.has(chat.projectId)) {
        const list = byProject.get(chat.projectId)
        if (list) list.push(chat)
        else byProject.set(chat.projectId, [chat])
      } else {
        recents.push(chat)
      }
    }
    return { byProject, recents }
  }, [chatMap, projects, query])

  const filtering = query.trim() !== ''
  const visibleProjects = filtering ? projects.filter((p) => byProject.has(p.id)) : projects

  return (
    <div className="flex h-full flex-col">
      <div className={cn('relative flex h-[46px] shrink-0 items-center justify-end gap-0.5 pr-2', platform === 'darwin' ? 'pl-[84px]' : 'pl-2')}>
        <div aria-hidden="true" className="drag relative z-0 h-full min-w-0 flex-1" />
        <IconButton
          label="Search chats"
          active={searching}
          onClick={() => {
            setSearching(!searching)
            setQuery('')
          }}
        >
          <Search size={15} />
        </IconButton>
        <IconButton label="Hide sidebar" onClick={() => useStore.setState({ sidebarOpen: false })}>
          <PanelLeft size={15} />
        </IconButton>
      </div>

      <div className="shrink-0 px-2 pb-2">
        {searching ? (
          <div className="flex h-8 items-center gap-2 rounded-lg border border-line-strong bg-inset px-2.5">
            <Search size={13} className="shrink-0 text-subtle" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setSearching(false)
                  setQuery('')
                }
              }}
              placeholder="Search chats"
              className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] placeholder:text-subtle"
            />
            {query && <X size={12} className="shrink-0 text-subtle hover:text-fg" onClick={() => setQuery('')} />}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => newChat()}
            className={cn(
              'flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[12.5px] transition-colors hover:bg-hover',
              activeId === null ? 'bg-hover text-fg' : 'text-fg'
            )}
          >
            <SquarePen size={14} className="text-muted" />
            <span className="flex-1 text-left">New chat</span>
            <kbd className="font-sans text-[11px] text-subtle">{platform === 'darwin' ? '⌘N' : 'Ctrl N'}</kbd>
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {visibleProjects.map((project) => (
          <ProjectGroup key={project.id} project={project} chats={byProject.get(project.id) ?? []} activeId={activeId} now={now} />
        ))}

        {recents.length > 0 && (
          <div className="mb-2">
            <div className="flex h-7 items-center px-2 text-[11px] font-medium text-subtle">Recents</div>
            <ChatList chats={recents} activeId={activeId} now={now} />
          </div>
        )}

        {filtering && visibleProjects.length === 0 && recents.length === 0 && (
          <div className="px-2 py-6 text-center text-[12px] text-subtle">No chats match.</div>
        )}
        {!filtering && projects.length === 0 && recents.length === 0 && (
          <div className="px-2 py-6 text-center text-[12px] leading-relaxed text-subtle">
            Chats will appear here,
            <br />
            grouped by project.
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-line p-2">
        <button
          type="button"
          onClick={() => useStore.setState({ settingsOpen: 'general' })}
          className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[12.5px] text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <SettingsIcon size={14} />
          <span className="flex-1 text-left">Settings</span>
        </button>
      </div>
    </div>
  )
}
