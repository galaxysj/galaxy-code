import {
  ArrowUp,
  Check,
  ChevronDown,
  File as FileIcon,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  FileText,
  GitBranch,
  Hand,
  Globe,
  Laptop,
  Paperclip,
  Plug,
  Plus,
  ShieldCheck,
  MessageCircle,
  Sparkles,
  Square,
  Unlock,
  X
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react'
import type { Attachment, Chat, Item, PermissionMode, ProjectFileEntry, PromptMentions, SkillInfo, ToolItem } from '@shared/types'
import { basename, cn, tildify } from '../lib/utils'
import { useActiveChat, useRunConfig, useStore } from '../store'
import { AcpOptions } from './AcpOptions'
import { ModelPicker } from './ModelPicker'
import { ApprovalPrompt } from './ApprovalPrompt'
import { SubscriptionPicker } from './SubscriptionPicker'
import { Button, MenuItem, MenuSeparator, Popover, Segmented, TextInput } from './ui'

const PERMISSION_MODES: { value: PermissionMode; label: string; description: string; icon: typeof Hand }[] = [
  { value: 'auto', label: 'Auto', description: 'A safety model approves routine work and asks you about risky actions.', icon: ShieldCheck },
  { value: 'ask', label: 'Ask for approval', description: 'Commands, edits and browser actions wait for you.', icon: Hand },
  { value: 'full', label: 'Full access', description: 'Everything runs without asking. Use with care.', icon: Unlock }
]

function PermissionPicker(): ReactNode {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const { permissionMode } = useRunConfig()
  const setPermissionMode = useStore((s) => s.setPermissionMode)
  const autoModel = useStore((s) => s.autoApprovalModel.name)
  const current = PERMISSION_MODES.find((m) => m.value === permissionMode) ?? PERMISSION_MODES[0]
  const Icon = current.icon
  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12.5px] transition-colors hover:bg-hover',
          permissionMode === 'full' ? 'text-warn' : 'text-muted hover:text-fg',
          open && 'bg-hover'
        )}
      >
        <Icon size={13.5} className="shrink-0" />
        <span className="truncate">{current.label}</span>
        <ChevronDown size={12} className={cn('picker-chevron shrink-0 opacity-60', open && 'rotate-180')} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="top-start" className="w-[300px] p-1">
        {PERMISSION_MODES.map((mode) => {
          const ModeIcon = mode.icon
          return (
            <button
              key={mode.value}
              type="button"
              onClick={() => {
                setPermissionMode(mode.value)
                setOpen(false)
              }}
              className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-hover"
            >
              <ModeIcon size={14} className={cn('mt-[2px] shrink-0', mode.value === 'full' ? 'text-warn' : 'text-muted')} />
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] text-fg">{mode.label}</span>
                <span className="block text-[11.5px] leading-snug text-muted">
                  {mode.value === 'auto' && autoModel ? `${autoModel} approves routine work and asks you about risky actions.` : mode.description}
                </span>
              </span>
              {mode.value === permissionMode && <Check size={13} className="mt-[3px] shrink-0 text-fg" />}
            </button>
          )
        })}
      </Popover>
    </>
  )
}

function NewProjectForm({ onDone, onBack }: { onDone(projectId: string): void; onBack(): void }): ReactNode {
  const homeDir = useStore((s) => s.homeDir)
  const notify = useStore((s) => s.notify)
  const [name, setName] = useState('')
  const [path, setPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const trimmed = name.trim()
  const target = path ?? (trimmed ? `${homeDir}/Documents/Galaxy/${trimmed}` : null)

  const create = async (): Promise<void> => {
    if (!trimmed && !path) return
    setBusy(true)
    try {
      const project = await window.galaxy.projects.create({ name: trimmed || undefined, path: path ?? undefined })
      onDone(project.id)
    } catch (err) {
      notify(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : 'Could not create the project', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="w-[320px] p-3">
      <div className="mb-2.5 text-[12.5px] font-medium text-fg">New project</div>
      <TextInput
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void create()
        }}
        placeholder={path ? basename(path) : 'Project name'}
      />
      <button
        type="button"
        onClick={async () => {
          const picked = await window.galaxy.projects.pickFolder()
          if (picked) setPath(picked)
        }}
        className="mt-2 flex h-7.5 w-full items-center gap-2 rounded-md border border-dashed border-line-strong px-2.5 text-left text-[12.5px] text-muted transition-colors hover:bg-hover hover:text-fg"
      >
        <FolderOpen size={13.5} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{path ? tildify(path, homeDir) : 'Choose an existing folder…'}</span>
        {path && (
          <X
            size={12}
            className="shrink-0 text-subtle hover:text-fg"
            onClick={(event) => {
              event.stopPropagation()
              setPath(null)
            }}
          />
        )}
      </button>
      <p className="mt-2 min-h-[30px] text-[11.5px] leading-snug text-subtle">
        {target ? (
          <>
            {path ? 'Uses' : 'Creates'} <span className="font-mono text-muted">{tildify(target, homeDir)}</span>
          </>
        ) : (
          'Name it to create a folder in Documents/Galaxy, or choose a folder you already have.'
        )}
      </p>
      <div className="mt-2 flex justify-end gap-1.5">
        <Button variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" size="sm" disabled={busy || (!trimmed && !path)} onClick={() => void create()}>
          Create project
        </Button>
      </div>
    </div>
  )
}

function ProjectChip({ chat }: { chat: Chat | null }): ReactNode {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const projects = useStore((s) => s.projects)
  const draft = useStore((s) => s.draft)
  const setDraft = useStore((s) => s.setDraft)
  const projectId = chat ? chat.projectId : draft.projectId
  const project = projects.find((p) => p.id === projectId) ?? null
  const locked = chat !== null
  const Icon = project ? (project.isGit ? FolderGit2 : Folder) : Folder

  const close = useCallback(() => {
    setOpen(false)
    setCreating(false)
  }, [])

  return (
    <>
      <button
        ref={anchor}
        type="button"
        disabled={locked}
        onClick={() => setOpen(!open)}
        title={project?.path}
        className={cn(
          'flex h-6 max-w-[240px] items-center gap-1.5 rounded-md px-1.5 text-[12px] text-muted transition-colors',
          !locked && 'hover:bg-hover hover:text-fg',
          open && 'bg-hover text-fg'
        )}
      >
        <Icon size={12.5} className="shrink-0" />
        <span className="truncate">{project?.name ?? 'No Project'}</span>
        {!locked && <ChevronDown size={11} className={cn('picker-chevron shrink-0 opacity-60', open && 'rotate-180')} />}
      </button>
      <Popover open={open} onClose={close} anchor={anchor} placement="top-start" className="overflow-hidden">
        {creating ? (
          <NewProjectForm
            onBack={() => setCreating(false)}
            onDone={(id) => {
              setDraft({ projectId: id, workspace: 'local' })
              close()
            }}
          />
        ) : (
          <div className="w-[260px] p-1">
            <div className="max-h-[260px] overflow-y-auto">
              <MenuItem
                icon={<Folder size={13.5} />}
                label="No Project"
                selected={projectId === null}
                onClick={() => {
                  setDraft({ projectId: null, workspace: 'local' })
                  close()
                }}
              />
              {projects.map((entry) => (
                <MenuItem
                  key={entry.id}
                  icon={entry.isGit ? <FolderGit2 size={13.5} /> : <Folder size={13.5} />}
                  label={entry.name}
                  selected={projectId === entry.id}
                  onClick={() => {
                    setDraft({ projectId: entry.id, workspace: 'local' })
                    close()
                  }}
                />
              ))}
            </div>
            <MenuSeparator />
            <MenuItem icon={<FolderPlus size={13.5} />} label="New Project" onClick={() => setCreating(true)} />
          </div>
        )}
      </Popover>
    </>
  )
}

/** Local or Worktree, offered only for projects that are git repositories. */
function WorkspaceToggle({ chat }: { chat: Chat | null }): ReactNode {
  const projects = useStore((s) => s.projects)
  const draft = useStore((s) => s.draft)
  const setDraft = useStore((s) => s.setDraft)
  const projectId = chat ? chat.projectId : draft.projectId
  const project = projects.find((p) => p.id === projectId)

  useEffect(() => {
    if (!chat && projectId) void window.galaxy.projects.git(projectId)
  }, [chat, projectId])

  if (!project?.isGit) return null
  if (chat) {
    return (
      <span className="flex h-6 items-center gap-1.5 px-1 text-[12px] text-subtle" title={chat.worktree?.path}>
        {chat.worktree ? <GitBranch size={12} /> : <Laptop size={12} />}
        <span className="max-w-[220px] truncate">{chat.worktree ? chat.worktree.branch : chat.workspace === 'worktree' ? 'Worktree' : 'Local'}</span>
      </span>
    )
  }
  return (
    <Segmented
      size="sm"
      value={draft.workspace}
      onChange={(workspace) => setDraft({ workspace })}
      options={[
        { value: 'local', label: (<><Laptop size={11.5} /> Local</>), title: 'Work directly in the project folder' },
        { value: 'worktree', label: (<><GitBranch size={11.5} /> Worktree</>), title: 'Work on a new branch in an isolated git worktree' }
      ]}
    />
  )
}

function AttachmentChip({ file, onRemove }: { file: Attachment; onRemove(): void }): ReactNode {
  return (
    <div className="group/att relative shrink-0">
      {file.preview ? (
        <img src={file.preview} alt="" className="h-14 w-14 rounded-lg border border-line object-cover" draggable={false} title={file.name} />
      ) : (
        <div className="flex h-14 max-w-[190px] items-center gap-2 rounded-lg border border-line bg-inset px-2.5" title={file.path}>
          <FileIcon size={15} className="shrink-0 text-muted" />
          <span className="min-w-0 truncate text-[12px] text-fg">{file.name}</span>
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-fg text-bg opacity-0 transition-opacity group-hover/att:opacity-100"
        title="Remove"
      >
        <X size={10} strokeWidth={3} />
      </button>
    </div>
  )
}

function AddMenu({ onAttach }: { onAttach(): void }): ReactNode {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        ref={anchor}
        type="button"
        title="Add"
        onClick={() => setOpen(!open)}
        className={cn('flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg', open && 'bg-hover text-fg')}
      >
        <Plus size={15} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="top-start" className="w-[220px] p-1">
        <MenuItem
          icon={<Paperclip size={13.5} />}
          label="Add files or photos"
          onClick={() => {
            setOpen(false)
            onAttach()
          }}
        />
        <MenuSeparator />
        <MenuItem
          icon={<Plug size={13.5} />}
          label="MCP servers"
          onClick={() => {
            setOpen(false)
            useStore.setState({ settingsOpen: 'mcp' })
          }}
        />
        <MenuItem
          icon={<Sparkles size={13.5} />}
          label="Skills"
          onClick={() => {
            setOpen(false)
            useStore.setState({ settingsOpen: 'skills' })
          }}
        />
      </Popover>
    </>
  )
}

export function Composer({ centered }: { centered?: boolean }): ReactNode {
  const chat = useActiveChat()
  const activeChatId = useStore((s) => s.activeChatId)
  const chats = useStore((s) => s.chats)
  const allChatItems = useStore((s) => s.items)
  const draft = useStore((s) => s.draft)
  const mcp = useStore((s) => s.mcp)
  const key = chat?.id ?? 'new'
  const text = useStore((s) => s.composerText[key] ?? '')
  const attachments = useStore((s) => s.composerAttachments[key]) ?? EMPTY
  const setText = useStore((s) => s.setComposerText)
  const setAttachments = useStore((s) => s.setComposerAttachments)
  const send = useStore((s) => s.send)
  const { model, ultra, acp } = useRunConfig()
  const textarea = useRef<HTMLTextAreaElement>(null)
  const [mention, setMention] = useState<{ trigger: '/' | '@'; start: number; end: number; query: string } | null>(null)
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [mentionFiles, setMentionFiles] = useState<ProjectFileEntry[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)
  const [selectedMentions, setSelectedMentions] = useState<SelectedMention[]>([])
  const [dragging, setDragging] = useState(false)
  const items = useStore((s) => chat ? s.items[chat.id] : undefined)
  const [responded, setResponded] = useState<Set<string>>(() => new Set())
  const approvals = (items ?? []).filter((item): item is ToolItem => item.kind === 'tool' && item.status === 'awaiting' && !!item.approval && !responded.has(item.approval.id))
  const pendingApproval = approvals[0]
  const approvalId = pendingApproval?.approval?.id
  const onRespond = useCallback((id: string) => setResponded((previous) => new Set([...previous, id])), [])
  const running = chat?.status === 'running' || chat?.status === 'awaiting'
  const projectId = chat?.projectId ?? draft.projectId
  const canSend = (text.trim().length > 0 || attachments.length > 0) && !!model

  useEffect(() => {
    let current = true
    void window.galaxy.skills.list(projectId).then((result) => { if (current) setSkills(result) }).catch(() => {})
    return () => { current = false }
  }, [projectId])

  useEffect(() => {
    if (!mention || mention.trigger !== '@' || !projectId) {
      setMentionFiles([])
      return
    }
    let current = true
    const load = mention.query.trim()
      ? window.galaxy.files.searchProject(projectId, mention.query, chat?.id)
      : window.galaxy.files.listProject(projectId, '', chat?.id)
    void load.then((files) => { if (current) setMentionFiles(files.filter((file) => !file.directory).slice(0, 12)) }).catch(() => { if (current) setMentionFiles([]) })
    return () => { current = false }
  }, [mention?.trigger, mention?.query, projectId, chat?.id])

  const recentChats = Object.values(chats)
    .filter((entry) => entry.id !== activeChatId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const mentionEntries: MentionEntry[] = mention?.trigger === '/'
    ? skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(mention.query.toLowerCase())).map((skill) => ({ id: `skill:${skill.path}`, kind: 'skill', name: skill.name, detail: skill.description || skill.scope, path: skill.path }))
    : mention?.trigger === '@'
      ? [
          { id: 'browser', kind: 'browser' as const, name: 'browser', detail: 'Use the in-app browser for this task.' },
          ...mcp.flatMap((server) => server.state === 'ready' ? server.tools.map((tool) => ({ id: `mcp:${server.id}:${tool.name}`, kind: 'mcp' as const, name: `${server.id}/${tool.name}`, detail: tool.description, server: server.id, tool: tool.name })) : []),
          ...recentChats.slice(0, 12).map((entry) => ({ id: `chat:${entry.id}`, kind: 'chat' as const, name: entry.title || 'Untitled chat', detail: 'Recent chat', chatId: entry.id })),
          ...mentionFiles.map((file) => ({ id: `file:${file.path}`, kind: 'file' as const, name: file.relativePath, detail: 'Project file', path: file.path }))
        ].filter((entry) => !mention.query || entry.name.toLowerCase().includes(mention.query.toLowerCase()) || entry.detail.toLowerCase().includes(mention.query.toLowerCase()))
      : []

  const updateMention = (value: string, caret: number): void => {
    const before = value.slice(0, caret)
    const match = /(^|\s)([/@])([^\s/@]*)$/.exec(before)
    if (!match) { setMention(null); return }
    const start = caret - match[0].length + match[1].length
    setMention({ trigger: match[2] as '/' | '@', start, end: caret, query: match[3] })
    setMentionIndex(0)
  }

  const replaceMention = (replacement: string): void => {
    if (!mention) return
    const next = `${text.slice(0, mention.start)}${replacement}${text.slice(mention.end)}`
    const caret = mention.start + replacement.length
    setText(key, next)
    setMention(null)
    requestAnimationFrame(() => {
      textarea.current?.focus()
      textarea.current?.setSelectionRange(caret, caret)
    })
  }

  const chooseMention = (entry: MentionEntry): void => {
    const token = entry.kind === 'skill' ? `/${entry.name}` : entry.kind === 'browser' ? '@browser' : `@${entry.name}`
    let selected: SelectedMention | null = null
    if (entry.kind === 'skill' && entry.path) selected = { id: entry.id, kind: 'skill', token, name: entry.name, path: entry.path }
    else if (entry.kind === 'file' && entry.path) selected = { id: entry.id, kind: 'file', token, name: entry.name, path: entry.path }
    else if (entry.kind === 'chat' && entry.chatId) selected = { id: entry.id, kind: 'chat', token, name: entry.name, chatId: entry.chatId }
    else if (entry.kind === 'browser') selected = { id: entry.id, kind: 'browser', token }
    else if (entry.kind === 'mcp' && entry.server && entry.tool) selected = { id: entry.id, kind: 'mcp', token, server: entry.server, name: entry.tool }
    if (!selected) return
    setSelectedMentions((previous) => previous.some((item) => item.id === selected!.id) ? previous : [...previous, selected!])
    replaceMention(`${token} `)
  }

  useLayoutEffect(() => {
    const el = textarea.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`
  }, [text, key, approvalId])

  useEffect(() => {
    textarea.current?.focus()
  }, [key, approvalId])

  const addAttachments = useCallback(
    (files: Attachment[]) => {
      if (files.length === 0) return
      const current = useStore.getState().composerAttachments[key] ?? []
      const seen = new Set(current.map((f) => f.path))
      setAttachments(key, [...current, ...files.filter((f) => !seen.has(f.path))])
    },
    [key, setAttachments]
  )

  const submit = async (): Promise<void> => {
    if (!canSend) return
    const outgoing = text
    const selected = selectedMentions.filter((item) => outgoing.includes(item.token))
    const mentionedChats: PromptMentions['chats'] = []
    for (const item of selected) {
      if (item.kind !== 'chat') continue
      const referenced = chats[item.chatId]
      if (!referenced) continue
      let transcript: Item[] = allChatItems[item.chatId] ?? []
      if (!transcript.length) transcript = await window.galaxy.chats.items(item.chatId).catch(() => [])
      const excerpt = transcript
        .flatMap((message) => message.kind === 'user' || message.kind === 'assistant' ? [message] : [])
        .filter((message) => message.text.trim())
        .slice(-16)
        .map((message) => `${message.kind === 'user' ? 'User' : 'Assistant'}: ${message.text.trim()}`)
        .join('\n')
        .slice(-12000)
      mentionedChats.push({ title: referenced.title, excerpt })
    }
    const mentions: PromptMentions = {
      skills: selected.flatMap((item) => item.kind === 'skill' ? [{ name: item.name, path: item.path }] : []),
      files: selected.flatMap((item) => item.kind === 'file' ? [{ name: item.name, path: item.path }] : []),
      chats: mentionedChats,
      browser: selected.some((item) => item.kind === 'browser'),
      tools: selected.flatMap((item) => item.kind === 'mcp' ? [{ server: item.server, name: item.name }] : [])
    }
    const files = attachments
    setText(key, '')
    setAttachments(key, [])
    setSelectedMentions([])
    setMention(null)
    void send(outgoing, files, mentions)
  }

  const onPaste = (event: ClipboardEvent): void => {
    const files = [...event.clipboardData.files]
    if (files.length === 0) return
    event.preventDefault()
    void Promise.all(
      files.map(async (file) => {
        const path = window.galaxy.files.pathForFile(file)
        if (path) return (await window.galaxy.files.attachFromPaths([path]))[0]
        const buffer = new Uint8Array(await file.arrayBuffer())
        let binary = ''
        for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000))
        return window.galaxy.files.attachFromData(file.name || 'pasted-image.png', file.type || 'image/png', btoa(binary))
      })
    ).then((added) => addAttachments(added.filter(Boolean)))
  }

  const onDrop = (event: DragEvent): void => {
    event.preventDefault()
    setDragging(false)
    const paths = [...event.dataTransfer.files].map((file) => window.galaxy.files.pathForFile(file)).filter(Boolean)
    if (paths.length) void window.galaxy.files.attachFromPaths(paths).then(addAttachments)
  }

  return (
    <div className={cn('mx-auto w-full max-w-[780px] px-6', centered ? 'pb-0' : 'pb-4')}>
      <div className="mb-1.5 flex h-6 items-center gap-1.5 pl-1">
        {!chat && <ProjectChip chat={chat} />}
        <WorkspaceToggle chat={chat} />
      </div>

      {chat && chat.queued.length > 0 && (
        <div className="mb-1.5 space-y-1">
          {chat.queued.map((message) => (
            <div key={message.id} className="flex h-7 items-center gap-2 rounded-lg border border-dashed border-line-strong px-2.5 text-[12px] text-muted">
              <span className="shrink-0 text-subtle">Queued</span>
              <span className="min-w-0 flex-1 truncate">{message.text || `${message.attachments.length} attachment(s)`}</span>
              <button type="button" title="Remove from queue" onClick={() => void window.galaxy.chats.unqueue(chat.id, message.id)} className="shrink-0 text-subtle hover:text-fg">
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {pendingApproval && chat ? (
        <ApprovalPrompt key={approvalId} chatId={chat.id} item={pendingApproval} remaining={approvals.length} onRespond={onRespond} />
      ) : <div
        key="message-box"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) {
            event.preventDefault()
            setDragging(true)
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'composer-swap relative rounded-2xl bg-elev shadow-composer transition-shadow focus-within:shadow-[0_0_0_1px_var(--border-strong),0_8px_24px_rgba(0,0,0,0.16)]',
          dragging && 'shadow-[0_0_0_2px_var(--blue)]!',
          ultra && 'aurora-ring'
        )}
      >
        {mention && mentionEntries.length > 0 && (
          <div role="listbox" aria-label={mention.trigger === '/' ? 'Skills' : 'Mentions'} className="absolute bottom-full left-2 right-2 z-40 mb-2 max-h-64 overflow-y-auto rounded-xl border border-line bg-elev p-1 shadow-pop">
            {mentionEntries.map((entry, index) => {
              const Icon = entry.kind === 'skill' ? Sparkles : entry.kind === 'file' ? FileText : entry.kind === 'chat' ? MessageCircle : entry.kind === 'browser' ? Globe : Plug
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="option"
                  aria-selected={index === mentionIndex}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseMention(entry)}
                  className={cn('flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left', index === mentionIndex ? 'bg-hover text-fg' : 'text-muted hover:bg-hover hover:text-fg')}
                >
                  <Icon size={14} className="shrink-0 text-subtle" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px]">{entry.name}</span>
                    <span className="block truncate text-[10.5px] text-subtle">{entry.detail}</span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3.5 pt-3.5">
            {attachments.map((file) => (
              <AttachmentChip key={file.id} file={file} onRemove={() => setAttachments(key, attachments.filter((f) => f.id !== file.id))} />
            ))}
          </div>
        )}
        <textarea
          ref={textarea}
          value={text}
          rows={1}
          onChange={(event) => {
            const value = event.target.value
            setText(key, value)
            updateMention(value, event.currentTarget.selectionStart)
          }}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (mention && mentionEntries.length > 0 && event.key === 'ArrowDown') {
              event.preventDefault()
              setMentionIndex((index) => (index + 1) % mentionEntries.length)
              return
            }
            if (mention && mentionEntries.length > 0 && event.key === 'ArrowUp') {
              event.preventDefault()
              setMentionIndex((index) => (index - 1 + mentionEntries.length) % mentionEntries.length)
              return
            }
            if (mention && mentionEntries.length > 0 && (event.key === 'Enter' || event.key === 'Tab')) {
              event.preventDefault()
              chooseMention(mentionEntries[mentionIndex] ?? mentionEntries[0])
              return
            }
            if (mention && event.key === 'Escape') {
              event.preventDefault()
              setMention(null)
              return
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder={
            acp && model
              ? chat
                ? running ? `Queue a follow-up for ${model.name}…` : `Reply to ${model.name}`
                : `Ask ${model.name} to build, fix, or explain something`
              : chat ? (running ? 'Queue a follow-up…' : 'Ask for follow-up changes') : 'Describe a task, ask a question, or paste an error'
          }
          className="block max-h-[40vh] min-h-[44px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[13.5px] leading-[1.55] placeholder:text-subtle"
        />
        <div className="flex flex-wrap items-center gap-0.5 px-2 pb-2 pt-1">
          <div className="flex min-w-0 flex-wrap items-center gap-0.5">
            <AddMenu onAttach={() => void window.galaxy.files.pickAttachments().then(addAttachments)} />
            {/* ACP agents bring their own session options, which take the place of the access mode and model pickers. */}
            {acp ? <AcpOptions /> : <PermissionPicker />}
          </div>
          <div className="ml-auto flex min-w-0 max-w-full items-center">
            {!acp && <ModelPicker />}
            {running && !canSend ? (
              <button
                type="button"
                title="Stop"
                onClick={() => chat && void window.galaxy.chats.stop(chat.id)}
                className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent transition-opacity hover:opacity-85"
              >
                <Square size={10.5} className="fill-current" />
              </button>
            ) : (
              <button
                type="button"
                title={running ? 'Queue message' : 'Send'}
                disabled={!canSend}
                onClick={submit}
                className={cn(
                  'ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-all',
                  canSend ? (ultra ? 'aurora-fill text-white' : 'bg-accent text-on-accent hover:opacity-85') : 'bg-active text-subtle'
                )}
              >
                <ArrowUp size={15} strokeWidth={2.4} />
              </button>
            )}
          </div>
        </div>
      </div>}
      <div className="mt-2 flex items-center justify-start">
        <SubscriptionPicker />
      </div>
    </div>
  )
}

const EMPTY: Attachment[] = []

type MentionKind = 'skill' | 'file' | 'chat' | 'browser' | 'mcp'
type SelectedMention =
  | { id: string; kind: 'skill'; token: string; name: string; path: string }
  | { id: string; kind: 'file'; token: string; name: string; path: string }
  | { id: string; kind: 'chat'; token: string; name: string; chatId: string }
  | { id: string; kind: 'browser'; token: string }
  | { id: string; kind: 'mcp'; token: string; server: string; name: string }
interface MentionEntry {
  id: string
  kind: MentionKind
  name: string
  detail: string
  path?: string
  chatId?: string
  server?: string
  tool?: string
}
