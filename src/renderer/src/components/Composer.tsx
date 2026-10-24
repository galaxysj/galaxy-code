import {
  ArrowUp,
  Check,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleQuestionMark,
  File as FileIcon,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  Laptop,
  Paperclip,
  Plug,
  Plus,
  MessageCircle,
  MessagesSquare,
  Package,
  Square,
  SquareTerminal,
  X
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react'
import type { AgentMode, Attachment, Chat, GitCommand, Item, PermissionMode, ProjectFileEntry, PromptMentions, RevertedMessage, SkillInfo, ToolItem } from '@shared/types'
import { basename, cn, tildify } from '../lib/utils'
import { GIT_COMMANDS, gitCommandFor, gitCommandMessage, gitToken } from '../lib/gitCommands'
import { useActiveChat, useChatId, useRunConfig, useStore, type PanelTab } from '../store'
import { FileIcon as FileTypeIcon } from './ProjectFiles'
import { AcpOptions } from './AcpOptions'
import { ModelPicker } from './ModelPicker'
import { ApprovalPrompt } from './ApprovalPrompt'
import { SubscriptionPicker } from './SubscriptionPicker'
import { Button, MenuItem, MenuSeparator, Popover, Segmented, Spinner, TextInput } from './ui'

const PERMISSION_MODES: { value: PermissionMode; label: string; description: string }[] = [
  { value: 'auto', label: 'Auto', description: 'A safety model approves routine work and asks you about risky actions.' },
  { value: 'ask', label: 'Ask for Approval', description: 'Commands, edits and browser actions wait for you.' },
  { value: 'accept-edits', label: 'Accept Edits', description: 'File changes inside the working directory run automatically. Other actions ask for approval.' },
  { value: 'full', label: 'Full Access', description: 'Everything runs without asking. Use with care.' }
]

function PermissionPicker(): ReactNode {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const { permissionMode } = useRunConfig()
  const setPermissionMode = useStore((s) => s.setPermissionMode)
  const chatId = useChatId()
  const autoModel = useStore((s) => s.autoApprovalModel.name)
  const current = PERMISSION_MODES.find((m) => m.value === permissionMode) ?? PERMISSION_MODES[0]
  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={cn(
          'flex h-7 items-center rounded-lg px-1 text-[12.5px] transition-colors hover:bg-hover',
          permissionMode === 'full' ? 'text-warn' : 'text-muted hover:text-fg',
          open && 'bg-hover'
        )}
      >
        <span className="truncate">{current.label}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="top-start" className="w-[300px] p-1">
        {PERMISSION_MODES.map((mode) => {
          return (
            <button
              key={mode.value}
              type="button"
              onClick={() => {
                setPermissionMode(mode.value, chatId)
                setOpen(false)
              }}
              className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-hover"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] text-fg">{mode.label}</span>
                <span className="block text-[11.5px] leading-snug text-muted">
                  {mode.value === 'auto' && autoModel ? 'Approves routine work and asks you about risky actions.' : mode.description}
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
  const openAttachment = useStore((s) => s.openAttachment)
  return (
    <div className="group/att relative shrink-0">
      {file.preview ? (
        <button type="button" onClick={() => openAttachment(file)} className="block h-14 w-14 cursor-zoom-in overflow-hidden rounded-lg border border-line" title={`Preview ${file.name}`}>
          <img src={file.preview} alt={file.name} className="h-full w-full object-cover" draggable={false} />
        </button>
      ) : (
        <button type="button" onClick={() => openAttachment(file)} className="flex h-14 max-w-[190px] items-center gap-2 rounded-lg border border-line bg-inset px-2.5 text-left" title={file.path}>
          <FileIcon size={15} className="shrink-0 text-muted" />
          <span className="min-w-0 truncate text-[12px] text-fg">{file.name}</span>
        </button>
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

const MODES: Record<AgentMode, { label: string; command: string; description: string; placeholder: string; icon: typeof Globe; tone: string }> = {
  ask: { label: 'Ask', command: 'ask', description: 'Answer questions with read-only tools. Nothing is changed.', placeholder: 'Ask questions', icon: CircleQuestionMark, tone: 'var(--green)' },
  plan: { label: 'Plan', command: 'plan', description: 'Research and write a plan to .galaxy/plans before building.', placeholder: 'Describe what to plan', icon: FileText, tone: 'var(--orange)' }
}

/** Commands that open a side chat. Text after the command becomes its first message. */
const SIDE_COMMANDS = ['side', 'btw']
const SIDE_COMMAND = /^\/(?:side|btw)(?:\s+|$)/i

function ModeChip({ mode, onClear }: { mode: AgentMode; onClear(): void }): ReactNode {
  const { label, description, icon: Icon, tone } = MODES[mode]
  return (
    <span
      title={description}
      className="ml-1 flex h-7 shrink-0 items-center gap-1 rounded-full pl-2.5 pr-1 text-[13px] font-medium"
      style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}
    >
      <Icon size={14} />
      <span>{label}</span>
      <button
        type="button"
        title={`Turn off ${label} mode`}
        aria-label={`Turn off ${label} mode`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClear}
        className="flex h-5 w-5 items-center justify-center rounded-full opacity-80 transition-opacity hover:opacity-100"
      >
        <X size={13} />
      </button>
    </span>
  )
}

function AddMenu({ onAdd }: { onAdd(): void }): ReactNode {
  return (
    <button
      type="button"
      title="Add context"
      aria-label="Add context"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onAdd}
      className="composer-bubble flex h-7 w-7 items-center justify-center rounded-full bg-active text-muted transition-colors hover:bg-hover hover:text-fg"
    >
      <Plus size={15} />
    </button>
  )
}

/** Terminal color and cursor codes, removed before output goes to the model. */
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g

/** Seeds the picker state from mentions a message was sent with. */
function selectedFrom(mentions: PromptMentions | undefined): SelectedMention[] {
  if (!mentions?.chips) return []
  return mentions.chips.flatMap((chip): SelectedMention[] => {
    const id = `${chip.kind}:${chip.token}`
    if (chip.kind === 'browser') return [{ id, kind: 'browser', token: chip.token }]
    if (chip.kind === 'git') {
      const command = gitCommandFor(chip.label)
      return command ? [{ id, kind: 'git', token: chip.token, command }] : []
    }
    if (chip.kind === 'file') {
      const file = mentions.files.find((entry) => entry.name === chip.label)
      return file ? [{ id, kind: 'file', token: chip.token, name: file.name, path: file.path }] : []
    }
    if (chip.kind === 'skill') {
      const skill = mentions.skills.find((entry) => entry.name === chip.label)
      return skill ? [{ id, kind: 'skill', token: chip.token, name: skill.name, path: skill.path }] : []
    }
    if (chip.kind === 'mcp') {
      if (chip.title) return [{ id: `mcp:${chip.title}`, kind: 'mcp', token: chip.token, server: chip.title, name: chip.label }]
      const tool = mentions.tools.find((entry) => entry.name === chip.label || chip.label.endsWith(`/${entry.name}`))
      return tool ? [{ id, kind: 'mcp', token: chip.token, server: tool.server, name: chip.label, tool: tool.name }] : []
    }
    return []
  })
}

/**
 * The message box. With `edit` it is a second box inside the timeline for a reverted
 * message: prefilled, with its own draft, and without the bar's workspace row or approvals.
 */
export function Composer({ centered, edit, footer }: { centered?: boolean; edit?: { key: string; message: RevertedMessage }; footer?: ReactNode }): ReactNode {
  const chat = useActiveChat()
  const activeChatId = useStore((s) => s.activeChatId)
  const chats = useStore((s) => s.chats)
  const allChatItems = useStore((s) => s.items)
  const draft = useStore((s) => s.draft)
  const mcp = useStore((s) => s.mcp)
  const mcpServers = useStore((s) => s.settings.mcpServers)
  const panelTabs = useStore((s) => s.panelTabs)
  const terminalOutput = useStore((s) => s.terminalOutput)
  const mentionQueue = useStore((s) => s.mentionQueue)
  const key = edit?.key ?? chat?.id ?? 'new'
  const text = useStore((s) => s.composerText[key] ?? '')
  const attachments = useStore((s) => s.composerAttachments[key]) ?? EMPTY
  const setText = useStore((s) => s.setComposerText)
  const setAttachments = useStore((s) => s.setComposerAttachments)
  const send = useStore((s) => s.send)
  const openSideChat = useStore((s) => s.openSideChat)
  const { model, ultra, acp } = useRunConfig()
  // Ask and Plan are enforced by Galaxy Code's own tools, so only native models offer them.
  const modesAvailable = model?.subscription === 'Default'
  const storedMode = useStore((s) => s.composerMode[key])
  const setComposerMode = useStore((s) => s.setComposerMode)
  const mode = modesAvailable ? storedMode : undefined
  const textarea = useRef<HTMLTextAreaElement>(null)
  const wrapProbe = useRef<HTMLDivElement>(null)
  const messageBox = useRef<HTMLDivElement>(null)
  const layoutSnapshot = useRef<{ key: string; compact: boolean; height: number; positions: Map<Element, DOMRect> } | null>(null)
  const layoutAnimations = useRef<Animation[]>([])
  const [wrapped, setWrapped] = useState(false)
  const [mention, setMention] = useState<{ trigger: '/' | '@'; start: number; end: number; query: string } | null>(null)
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [mentionFiles, setMentionFiles] = useState<ProjectFileEntry[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)
  const [selectedMentions, setSelectedMentions] = useState<SelectedMention[]>(() => selectedFrom(edit?.message.mentions))
  // Mentions added from elsewhere, such as Add to Chat in a terminal, go at the end of the message.
  useEffect(() => {
    if (edit || chat?.side || mentionQueue.length === 0) return
    const queued = useStore.getState().takeMentions()
    let current = useStore.getState().composerText[key] ?? ''
    const added: SelectedMention[] = []
    for (const item of queued) {
      let token = `@ ${item.name}`
      for (let n = 2; current.includes(token); n++) token = `@ ${item.name} ${n}`
      added.push({ id: `terminal:${item.tabId}:${token}`, kind: 'terminal', token, name: token.slice(2), tabId: item.tabId, cwd: item.cwd, selection: item.selection })
      current = `${current}${current && !/\s$/.test(current) ? ' ' : ''}${token} `
    }
    setSelectedMentions((previous) => [...previous, ...added])
    setText(key, current)
    requestAnimationFrame(() => {
      const el = textarea.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }, [mentionQueue, edit, key]) // eslint-disable-line react-hooks/exhaustive-deps
  // An edit box starts from the reverted message once; later edits are its own draft.
  useEffect(() => {
    if (!edit) return
    const state = useStore.getState()
    if (!state.composerText[edit.key] && !state.composerAttachments[edit.key]?.length) {
      setText(edit.key, edit.message.text)
      setAttachments(edit.key, edit.message.attachments)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const mirror = useRef<HTMLDivElement>(null)
  const mentionList = useRef<HTMLDivElement>(null)
  // Keep the highlighted pick in view while moving through the list with the arrow keys.
  useEffect(() => {
    mentionList.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [mentionIndex])
  const chipTokens = selectedMentions.filter((item) => text.includes(item.token))
  const caretDirection = useRef<'left' | 'right' | null>(null)
  const mentionRanges = useMemo(() => {
    const tokens = [...new Set(selectedMentions.map((item) => item.token))].filter(Boolean).sort((a, b) => b.length - a.length)
    if (!tokens.length) return []
    const pattern = new RegExp(tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
    return [...text.matchAll(pattern)].map((match) => ({ start: match.index, end: match.index + match[0].length }))
  }, [text, selectedMentions])
  const [dragging, setDragging] = useState(false)
  const items = useStore((s) => chat ? s.items[chat.id] : undefined)
  const [responded, setResponded] = useState<Set<string>>(() => new Set())
  const approvals = edit ? [] : (items ?? []).filter((item): item is ToolItem => item.kind === 'tool' && item.status === 'awaiting' && !!item.approval && !responded.has(item.approval.id))
  const pendingApproval = approvals[0]
  const approvalId = pendingApproval?.approval?.id
  const onRespond = useCallback((id: string) => setResponded((previous) => new Set([...previous, id])), [])
  const running = chat?.status === 'running' || chat?.status === 'awaiting'
  const projectId = chat?.projectId ?? draft.projectId
  const hasOwnMessage = !chat?.side || (items ?? []).slice(chat.sideContextItemCount ?? 0).some((item) => item.kind === 'user' && !item.parentId)
  const followUp = !!chat && !edit && hasOwnMessage
  const compact = followUp && !text.includes('\n') && !wrapped && attachments.length === 0 && !acp && !mode
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

  const terminalTabs = panelTabs.filter((tab): tab is Extract<PanelTab, { type: 'terminal' }> => tab.type === 'terminal' && !terminalOutput[tab.id]?.exited)
  const recentChats = Object.values(chats)
    .filter((entry) => entry.id !== activeChatId && !entry.side)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const mentionEntries: MentionEntry[] = mention?.trigger === '/'
    ? [
        ...(modesAvailable ? (Object.keys(MODES) as AgentMode[]) : [])
          .filter((value) => MODES[value].command.startsWith(mention.query.toLowerCase()))
          .map((value) => ({ id: `mode:${value}`, kind: 'mode' as const, name: `/${MODES[value].command}`, detail: MODES[value].description, mode: value })),
        ...(edit ? [] : SIDE_COMMANDS)
          .filter((command) => command.startsWith(mention.query.toLowerCase()))
          .map((command) => ({ id: `command:${command}`, kind: 'command' as const, name: `/${command}`, detail: 'Open a side chat in the panel. It is deleted when closed.' })),
        ...(Object.keys(GIT_COMMANDS) as GitCommand[])
          .filter((command) => command.startsWith(mention.query.toLowerCase()))
          .map((command) => ({ id: `git:${command}`, kind: 'git' as const, name: `/${command}`, detail: GIT_COMMANDS[command].detail, git: command })),
        ...skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(mention.query.toLowerCase())).map((skill) => ({ id: `skill:${skill.path}`, kind: 'skill' as const, name: skill.name, detail: skill.description || skill.scope, path: skill.path }))
      ]
    : mention?.trigger === '@'
      ? [
          { id: 'upload', kind: 'upload' as const, name: 'Add files or photos', detail: 'Upload attachments from your computer.' },
          ...skills.map((skill) => ({ id: `skill:${skill.path}`, kind: 'skill' as const, name: skill.name, detail: skill.description || skill.scope, path: skill.path })),
          { id: 'browser', kind: 'browser' as const, name: 'Browser', detail: 'Use the in-app browser for this task.' },
          ...mcp.filter((server) => server.state === 'ready').map((server) => ({ id: `mcp:${server.id}`, kind: 'mcp' as const, name: mcpServers.find((config) => config.id === server.id)?.name ?? server.id, detail: `${server.tools.length} tools`, server: server.id })),
          ...terminalTabs.map((tab) => ({ id: `terminal:${tab.id}`, kind: 'terminal' as const, name: tab.customTitle || tab.title, detail: tab.cwd, tabId: tab.id, cwd: tab.cwd })),
          ...recentChats.slice(0, 12).map((entry) => ({ id: `chat:${entry.id}`, kind: 'chat' as const, name: entry.title || 'Untitled chat', detail: '', chatId: entry.id })),
          ...mentionFiles.map((file) => ({ id: `file:${file.path}`, kind: 'file' as const, name: file.relativePath.split('/').pop() ?? file.relativePath, detail: file.relativePath.includes('/') ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/')) : '', path: file.path }))
        ].filter((entry) => !mention.query || entry.kind === 'file' || entry.name.toLowerCase().includes(mention.query.toLowerCase()))
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

  const insertMention = (): void => {
    const el = textarea.current
    if (!el) return
    const start = el.selectionStart
    const end = el.selectionEnd
    const prefix = text.slice(0, start)
    const trigger = `${prefix && !/\s$/.test(prefix) ? ' ' : ''}@`
    const next = `${prefix}${trigger}${text.slice(end)}`
    const caret = start + trigger.length
    setText(key, next)
    updateMention(next, caret)
    el.focus()
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(caret, caret)
    })
  }

  const chooseMention = (entry: MentionEntry): void => {
    if (entry.kind === 'command' && mention) {
      const rest = `${text.slice(0, mention.start)}${text.slice(mention.end)}`.trim()
      setText(key, '')
      setSelectedMentions([])
      setMention(null)
      void openSideChat(rest, chat?.id)
      return
    }
    if (entry.kind === 'mode' && entry.mode) {
      replaceMention('')
      setComposerMode(key, entry.mode)
      return
    }
    if (entry.kind === 'git' && entry.git) {
      const selected: SelectedMention = { id: entry.id, kind: 'git', token: gitToken(entry.git), command: entry.git }
      setSelectedMentions((previous) => previous.some((item) => item.id === selected.id) ? previous : [...previous, selected])
      replaceMention(`${selected.token} `)
      return
    }
    if (entry.kind === 'upload') {
      replaceMention('')
      void window.galaxy.files.pickAttachments().then(addAttachments).catch(() => {
        useStore.getState().notify('Could not add attachments.', 'error')
      }).finally(() => textarea.current?.focus())
      return
    }
    // Every pick becomes an "@ name" token: the chip icon covers the @ and the space keeps it off the name.
    const token = `@ ${entry.name}`
    let selected: SelectedMention | null = null
    if (entry.kind === 'skill' && entry.path) selected = { id: entry.id, kind: 'skill', token, name: entry.name, path: entry.path }
    else if (entry.kind === 'file' && entry.path) selected = { id: entry.id, kind: 'file', token, name: entry.name, path: entry.path }
    else if (entry.kind === 'chat' && entry.chatId) selected = { id: entry.id, kind: 'chat', token, name: entry.name, chatId: entry.chatId }
    else if (entry.kind === 'browser') selected = { id: entry.id, kind: 'browser', token }
    else if (entry.kind === 'mcp' && entry.server) selected = { id: entry.id, kind: 'mcp', token, server: entry.server, name: entry.name }
    else if (entry.kind === 'terminal' && entry.tabId) selected = { id: entry.id, kind: 'terminal', token, name: entry.name, tabId: entry.tabId, cwd: entry.cwd ?? '' }
    if (!selected) return
    setSelectedMentions((previous) => previous.some((item) => item.id === selected!.id) ? previous : [...previous, selected!])
    replaceMention(`${token} `)
  }

  // Keep one probe at the compact width. Reusing it avoids inserting and
  // removing a textarea, and rebuilding a resize observer, on every keystroke.
  const measureWrap = useCallback(() => {
    const probe = wrapProbe.current
    if (!probe) return
    const lineHeight = parseFloat(getComputedStyle(probe).lineHeight)
    setWrapped(probe.getBoundingClientRect().height > lineHeight + 1)
  }, [])

  useLayoutEffect(() => {
    if (followUp) measureWrap()
  }, [text, key, followUp, approvalId, measureWrap])

  useLayoutEffect(() => {
    const probe = wrapProbe.current
    if (!probe || !followUp) return
    const observer = new ResizeObserver(measureWrap)
    observer.observe(probe)
    return () => observer.disconnect()
  }, [key, followUp, approvalId, measureWrap])

  const fitTextarea = useCallback(() => {
    const el = textarea.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`
  }, [])

  useLayoutEffect(fitTextarea, [text, key, approvalId, compact, fitTextarea])

  // A box that opens inside an animating panel is measured while narrow; refit once its width settles.
  useLayoutEffect(() => {
    const el = textarea.current
    if (!el) return
    let width = el.clientWidth
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return
      width = el.clientWidth
      fitTextarea()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [key, approvalId, fitTextarea])

  useLayoutEffect(() => {
    const box = messageBox.current
    if (!box) { layoutSnapshot.current = null; return }
    const previous = layoutSnapshot.current
    const changingMode = previous?.key === key && previous.compact !== compact
    if (!changingMode && previous?.key === key && layoutAnimations.current.some((animation) => animation.playState === 'running')) return
    const currentHeight = box.getBoundingClientRect().height
    layoutAnimations.current.forEach((animation) => animation.cancel())
    layoutAnimations.current = []
    const height = box.getBoundingClientRect().height
    const controls = box.querySelectorAll<HTMLElement>('.composer-input, .composer-options > button:first-child, .composer-model, .composer-actions > button')
    const positions = new Map<Element, DOMRect>()
    controls.forEach((control) => positions.set(control, control.getBoundingClientRect()))
    layoutSnapshot.current = { key, compact, height, positions }
    if (!changingMode || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const timing = { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
    layoutAnimations.current.push(box.animate([
      { height: `${currentHeight !== height ? currentHeight : previous.height}px`, overflow: 'clip' },
      { height: `${height}px`, overflow: 'clip' }
    ], timing))
    positions.forEach((rect, control) => {
      const old = previous.positions.get(control)
      if (!old) return
      layoutAnimations.current.push(control.animate([
        { transform: `translate(${old.left - rect.left}px, ${old.top - rect.top}px)` },
        { transform: 'translate(0, 0)' }
      ], timing))
    })
  }, [compact, text, key, approvalId, attachments.length])

  useEffect(() => () => {
    layoutAnimations.current.forEach((animation) => animation.cancel())
  }, [])

  useEffect(() => {
    if (!edit) textarea.current?.focus()
  }, [key, approvalId]) // eslint-disable-line react-hooks/exhaustive-deps

  const addAttachments = useCallback(
    (files: Attachment[]) => {
      if (files.length === 0) return
      const current = useStore.getState().composerAttachments[key] ?? []
      const seen = new Set(current.map((f) => f.path))
      setAttachments(key, [...current, ...files.filter((f) => !seen.has(f.path))])
    },
    [key, setAttachments]
  )

  const submit = async (steer = false): Promise<void> => {
    if (!canSend) return
    const side = edit ? null : SIDE_COMMAND.exec(text)
    if (side) {
      setText(key, '')
      setSelectedMentions([])
      setMention(null)
      void openSideChat(text.slice(side[0].length), chat?.id)
      return
    }
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
    // A typed /commit or /commit-push works like the picked one.
    const git = selected.find((item) => item.kind === 'git')?.command ?? (/^\/(commit-push|commit)(?=\s|$)/.exec(outgoing.trim())?.[1] as GitCommand | undefined)
    const mentions: PromptMentions = {
      ...(git ? { git } : {}),
      skills: selected.flatMap((item) => item.kind === 'skill' ? [{ name: item.name, path: item.path }] : []),
      files: selected.flatMap((item) => item.kind === 'file' ? [{ name: item.name, path: item.path }] : []),
      chats: mentionedChats,
      browser: selected.some((item) => item.kind === 'browser'),
      tools: selected.flatMap((item) => {
        if (item.kind !== 'mcp') return []
        if (item.tool) return [{ server: item.server, name: item.tool }]
        return (mcp.find((server) => server.id === item.server)?.tools ?? []).map((tool) => ({ server: item.server, name: tool.name }))
      }),
      terminals: selected.flatMap((item) => {
        if (item.kind !== 'terminal') return []
        // A selection goes as it was picked; a whole tab sends the end of its output, without color codes.
        const text = item.selection ?? (useStore.getState().terminalOutput[item.tabId]?.text ?? '').slice(-12000).replace(ANSI, '')
        return [{ name: item.name, tabId: item.tabId, cwd: item.cwd, text, selection: item.selection !== undefined }]
      }),
      chips: selected.map((item) => ({
        token: item.token,
        kind: item.kind,
        label: item.kind === 'browser' ? 'Browser' : item.kind === 'git' ? GIT_COMMANDS[item.command].label : item.name,
        ...(item.kind === 'file' ? { title: item.path } : {}),
        ...(item.kind === 'terminal' ? { title: item.selection ? item.selection.slice(0, 400) : item.cwd } : {}),
        ...(item.kind === 'mcp' && !item.tool ? { title: item.server } : {})
      }))
    }
    const files = attachments
    setText(key, '')
    setAttachments(key, [])
    setSelectedMentions([])
    setMention(null)
    void send(outgoing, files, mentions, steer, mode, undefined, chat?.id ?? null)
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
    <div className={cn(!edit && 'mx-auto w-full max-w-[780px] px-6', !edit && (centered ? 'pb-0' : 'pb-4'))}>
      {!edit && !compact && !chat?.side && (
        <div className="mb-1.5 flex h-6 items-center gap-1.5 pl-1">
          {!chat && <ProjectChip chat={chat} />}
          <WorkspaceToggle chat={chat} />
        </div>
      )}

      {!edit && chat && <CurrentTask chat={chat} items={items} />}

      {followUp && chat && !chat.side && <GitChips chat={chat} />}

      {!edit && chat && chat.queued.length > 0 && (
        <div className="mb-1.5 space-y-1">
          {chat.queued.map((message) => (
            <div key={message.id} className="flex h-7 items-center gap-2 rounded-lg border border-dashed border-line-strong px-2.5 text-[12px] text-muted">
              <span className="shrink-0 text-subtle">Queued</span>
              <span className="min-w-0 flex-1 truncate">{message.plan ? `Build ${basename(message.plan)}` : message.text || `${message.attachments.length} attachment(s)`}</span>
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
        ref={messageBox}
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
          compact && 'composer-compact',
          dragging && 'shadow-[0_0_0_2px_var(--blue)]!',
          ultra && 'aurora-ring'
        )}
      >
        {followUp && (
          <div aria-hidden="true" className="composer-wrap-measure">
            <div ref={wrapProbe} className="composer-wrap-probe">{text || '\u200b'}</div>
          </div>
        )}
        {mention && mentionEntries.length > 0 && (
          <div ref={mentionList} role="listbox" aria-label={mention.trigger === '/' ? 'Commands' : 'Mentions'} className={cn('absolute left-2 right-2 z-40 max-h-80 overflow-y-auto flex flex-col gap-0.5 rounded-2xl border border-line bg-elev p-2 shadow-pop', edit ? 'top-full mt-2' : 'bottom-full mb-2')}>
            {mentionEntries.map((entry, index) => {
              const Icon = entry.mode ? MODES[entry.mode].icon : CHIP_ICON[entry.kind]
              const heading = index === 0 || mentionEntries[index - 1].kind !== entry.kind ? MENU_HEADINGS[entry.kind] : null
              return (
                <div key={entry.id} role="presentation">
                {heading && <div className={cn('px-3 pb-1 text-[11px] font-medium text-subtle', index > 0 ? 'pt-2.5' : 'pt-1')}>{heading}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === mentionIndex}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseMention(entry)}
                  title={entry.detail || undefined}
                  onMouseMove={() => { if (index !== mentionIndex) setMentionIndex(index) }}
                  className={cn('flex h-9.5 w-full min-w-0 items-center gap-3 rounded-lg px-3 text-left', index === mentionIndex ? 'bg-hover text-fg' : 'text-muted')}
                >
                  <span className="flex w-4 shrink-0 justify-center">{entry.kind === 'file' ? <FileTypeIcon name={entry.name} /> : <Icon size={15} className="text-subtle" />}</span>
                  <span className="flex min-w-0 flex-1 items-baseline gap-2.5">
                    <span className="max-w-[60%] shrink-0 truncate text-[13px] text-fg">{entry.name}</span>
                    <span className="min-w-0 truncate text-[11.5px] text-subtle">{entry.detail}</span>
                  </span>
                </button>
                </div>
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
        <div className="composer-input relative">
        {chipTokens.length > 0 && (
          <div ref={mirror} aria-hidden="true" className="composer-mention-mirror pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-4 pb-1 pt-3.5 text-[14.7px] leading-[1.55] text-fg">
            <ComposerChips text={text} mentions={chipTokens} />
          </div>
        )}
        <textarea
          ref={textarea}
          value={text}
          onScroll={(event) => { if (mirror.current) mirror.current.scrollTop = event.currentTarget.scrollTop }}
          rows={1}
          onPointerDown={() => { caretDirection.current = null }}
          onSelect={(event) => {
            const element = event.currentTarget
            const start = element.selectionStart
            const end = element.selectionEnd
            const startToken = mentionRanges.find((range) => start > range.start && start < range.end)
            const endToken = mentionRanges.find((range) => end > range.start && end < range.end)
            if (start === end && startToken) {
              const caret = caretDirection.current === 'left' ? startToken.start
                : caretDirection.current === 'right' ? startToken.end
                  : start - startToken.start < startToken.end - start ? startToken.start : startToken.end
              element.setSelectionRange(caret, caret)
            } else if (start !== end && (startToken || endToken)) {
              element.setSelectionRange(startToken?.start ?? start, endToken?.end ?? end, element.selectionDirection)
            }
          }}
          onChange={(event) => {
            const value = event.target.value
            // Expand edits touching a mention to the whole token. This also
            // covers selection deletion, cut, paste, and word-delete shortcuts.
            let start = 0
            while (start < text.length && start < value.length && text[start] === value[start]) start++
            let oldEnd = text.length
            let newEnd = value.length
            while (oldEnd > start && newEnd > start && text[oldEnd - 1] === value[newEnd - 1]) { oldEnd--; newEnd-- }
            let from = start
            let to = oldEnd
            if (chipTokens.length > 0) {
              const tokens = [...new Set(chipTokens.map((item) => item.token))].sort((a, b) => b.length - a.length)
              const pattern = new RegExp(tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
              for (const match of text.matchAll(pattern)) {
                const tokenStart = match.index
                const tokenEnd = tokenStart + match[0].length
                if (start < tokenEnd && oldEnd > tokenStart || start === oldEnd && start > tokenStart && start < tokenEnd) {
                  from = Math.min(from, tokenStart)
                  to = Math.max(to, tokenEnd)
                }
              }
            }
            if (from !== start || to !== oldEnd) {
              const replacement = value.slice(start, newEnd)
              const next = text.slice(0, from) + replacement + text.slice(to)
              const caret = from + replacement.length
              const element = event.currentTarget
              setText(key, next)
              setSelectedMentions((previous) => previous.filter((item) => next.includes(item.token)))
              updateMention(next, caret)
              requestAnimationFrame(() => element.setSelectionRange(caret, caret))
              return
            }
            setText(key, value)
            setSelectedMentions((previous) => previous.filter((item) => value.includes(item.token)))
            updateMention(value, event.currentTarget.selectionStart)
          }}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.metaKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit(true)
              return
            }
            if (['ArrowLeft', 'ArrowUp', 'Home'].includes(event.key)) caretDirection.current = 'left'
            else if (['ArrowRight', 'ArrowDown', 'End'].includes(event.key)) caretDirection.current = 'right'
            else caretDirection.current = null
            if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !event.metaKey && !event.ctrlKey && !event.altKey && !event.nativeEvent.isComposing) {
              const element = event.currentTarget
              const start = element.selectionStart
              const end = element.selectionEnd
              const backward = element.selectionDirection === 'backward'
              const focus = backward ? start : end
              const anchor = backward ? end : start
              const left = event.key === 'ArrowLeft'
              const range = mentionRanges.find((token) => left ? focus > token.start && focus <= token.end : focus >= token.start && focus < token.end)
              if (range && (event.shiftKey || start === end)) {
                event.preventDefault()
                const target = left ? range.start : range.end
                if (event.shiftKey) element.setSelectionRange(Math.min(anchor, target), Math.max(anchor, target), target < anchor ? 'backward' : 'forward')
                else element.setSelectionRange(target, target)
                return
              }
            }
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
            if (event.key === 'Backspace' && mode && event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0) {
              event.preventDefault()
              return
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder={mode ? MODES[mode].placeholder : compact ? 'Send follow-up' :
            acp && model
              ? chat
                ? running ? `Queue a follow-up for ${model.name}…` : `Reply to ${model.name}`
                : `Ask ${model.name} to build, fix, or explain something`
              : chat ? (running ? 'Queue a follow-up…' : 'Ask for follow-up changes') : 'Describe a task, ask a question, or paste an error'
          }
          className={cn('relative block max-h-[40vh] min-h-[44px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[14.7px] leading-[1.55] placeholder:text-subtle', chipTokens.length > 0 && 'text-transparent caret-[var(--fg)]')}
        />
        </div>
        <div className="composer-toolbar flex flex-wrap items-center gap-0.5 px-2 pb-2 pt-1">
          <div className="composer-options flex min-w-0 flex-wrap items-center gap-0.5">
            <AddMenu onAdd={insertMention} />
            {mode && <ModeChip mode={mode} onClear={() => { setComposerMode(key, undefined); textarea.current?.focus() }} />}
            {/* ACP agents bring their own session options, which take the place of the access mode and model pickers. */}
            {acp && <AcpOptions />}
          </div>
          <div className="composer-actions ml-auto flex min-w-0 max-w-full items-center">
            {!acp && <span className="composer-model flex min-w-0 items-center"><ModelPicker /></span>}
            {running && !canSend ? (
              <button
                type="button"
                title="Stop"
                onClick={() => chat && void window.galaxy.chats.stop(chat.id)}
                className="composer-bubble ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent transition-opacity hover:opacity-85"
              >
                <Square size={10.5} className="fill-current" />
              </button>
            ) : (
              <button
                type="button"
                title={running ? 'Queue message' : 'Send'}
                disabled={!canSend}
                onClick={() => void submit()}
                className={cn(
                  'composer-bubble ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors',
                  canSend ? (ultra ? 'aurora-fill text-white' : 'bg-accent text-on-accent hover:opacity-85') : 'bg-active text-subtle'
                )}
              >
                <ArrowUp size={15} strokeWidth={2.4} />
              </button>
            )}
          </div>
        </div>
      </div>}
      <div className="mt-2 flex min-h-7 items-center justify-start gap-1 [&>div:first-child]:pr-0 [&>button:first-child]:pr-0">
        {footer ?? <SubscriptionPicker />}
        {!edit && <PermissionPicker />}
      </div>
    </div>
  )
}

const EMPTY: Attachment[] = []

/** While the agent works: the step it is on, with the whole plan on hover. */
/** Round Commit and Commit & Push chips above the box, shown mid-chat while the folder has uncommitted changes. */
function GitChips({ chat }: { chat: Chat }): ReactNode {
  const cwd = useStore((s) => chat.worktree?.path ?? s.projects.find((entry) => entry.id === chat.projectId)?.path)
  const [git, setGit] = useState<{ dirty: boolean; hasRemote: boolean } | null>(null)
  const idle = chat.status !== 'running' && chat.status !== 'awaiting'
  // Recheck whenever the agent finishes, since a turn may have edited or committed files.
  useEffect(() => {
    if (!cwd || !idle) return
    let cancelled = false
    void window.galaxy.review.state(cwd).then((value) => { if (!cancelled) setGit(value.isRepo ? value : null) }).catch(() => { if (!cancelled) setGit(null) })
    return () => { cancelled = true }
  }, [cwd, idle, chat.updatedAt])
  if (!idle || !git?.dirty) return null
  const commands: GitCommand[] = git.hasRemote ? ['commit', 'commit-push'] : ['commit']
  return (
    <div className="mb-2 flex items-center gap-2">
      {commands.map((command) => (
        <button
          key={command}
          type="button"
          title={GIT_COMMANDS[command].detail}
          onClick={() => {
            const { text, mentions } = gitCommandMessage(command)
            void useStore.getState().send(text, [], mentions, false, undefined, undefined, chat.id)
          }}
          className="flex h-8 items-center gap-1.5 rounded-full bg-elev px-3.5 text-[13px] text-fg shadow-composer transition-colors hover:bg-hover"
        >
          <GitCommitHorizontal size={14} style={{ color: 'var(--orange)' }} />
          {GIT_COMMANDS[command].label}
        </button>
      ))}
    </div>
  )
}

function CurrentTask({ chat, items }: { chat: Chat; items: Item[] | undefined }): ReactNode {
  if (chat.status !== 'running' && chat.status !== 'awaiting') return null
  const list = items ?? []
  const lastUser = list.findLastIndex((item) => item.kind === 'user' && !item.parentId)
  const plan = list.slice(lastUser + 1).findLast((item): item is ToolItem => item.kind === 'tool' && item.tool === 'task' && !item.parentId && !!item.meta?.tasks?.length)
  const tasks = plan?.meta?.tasks ?? []
  const current = tasks.find((task) => task.status === 'in_progress') ?? tasks.find((task) => task.status === 'pending')
  if (!current) return null
  const done = tasks.filter((task) => task.status === 'completed').length
  return (
    <div className="group/task relative mb-1.5 flex h-7 items-center gap-2 px-2 text-[13px] text-muted">
      <Spinner size={13} className="shrink-0" />
      <span className="shimmer min-w-0 truncate">{current.content}</span>
      <span className="shrink-0 text-[11.5px] tabular-nums text-subtle">{done}/{tasks.length}</span>
      <div className="pointer-events-none absolute bottom-full left-0 z-30 mb-1 w-full max-w-[520px] rounded-xl border border-line bg-elev p-2.5 opacity-0 shadow-pop transition-opacity group-hover/task:pointer-events-auto group-hover/task:opacity-100">
        {tasks.map((task, index) => (
          <div key={index} className="flex items-start gap-2 py-1 text-[12.5px] leading-snug">
            {task.status === 'completed' ? <CircleCheck size={13} className="mt-0.5 shrink-0 text-ok" /> : task.status === 'in_progress' ? <CircleDot size={13} className="mt-0.5 shrink-0 text-fg" /> : <CircleDashed size={13} className="mt-0.5 shrink-0 text-subtle" />}
            <span className={cn('min-w-0', task.status === 'completed' ? 'text-subtle line-through' : task.status === 'in_progress' ? 'text-fg' : 'text-muted')}>{task.content}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

const MENU_HEADINGS: Record<MentionKind, string> = { mode: 'Modes', command: 'Commands', upload: 'Attachments', skill: 'Skills', git: 'Git', browser: 'Tools', mcp: 'MCP servers', terminal: 'Terminals', chat: 'Recent chats', file: 'Files' }

const CHIP_ICON: Record<MentionKind, typeof Globe> = { mode: FileText, command: MessagesSquare, upload: Paperclip, skill: Package, file: FileText, chat: MessageCircle, browser: Globe, mcp: Plug, terminal: SquareTerminal, git: GitCommitHorizontal }

/**
 * Draws picked mentions as chips under the transparent textarea text. Each chip keeps
 * the token's exact characters (the trigger hides behind the icon) so the caret lines up.
 */
function ComposerChips({ text, mentions }: { text: string; mentions: SelectedMention[] }): ReactNode {
  const byToken = new Map(mentions.map((item) => [item.token, item]))
  const pattern = new RegExp(`(${[...byToken.keys()].sort((a, b) => b.length - a.length).map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g')
  return (
    <>
      {text.split(pattern).map((part, index) => {
        const item = byToken.get(part)
        if (!item) return part
        const Icon = CHIP_ICON[item.kind]
        return (
          <span key={index} className="text-link" style={item.kind === 'git' ? { color: 'var(--orange)' } : undefined}>
            <span className="relative">
              <span className="invisible">{part[0]}</span>
              <span className="absolute left-0 top-1/2 flex -translate-y-1/2">{item.kind === 'file' ? <FileTypeIcon name={item.name} size={11} /> : <Icon size={13} />}</span>
            </span>
            {part.slice(1)}
          </span>
        )
      })}
      {'\u200b'}
    </>
  )
}

type MentionKind = 'mode' | 'command' | 'git' | 'upload' | 'skill' | 'file' | 'chat' | 'browser' | 'mcp' | 'terminal'
type SelectedMention =
  | { id: string; kind: 'skill'; token: string; name: string; path: string }
  | { id: string; kind: 'file'; token: string; name: string; path: string }
  | { id: string; kind: 'chat'; token: string; name: string; chatId: string }
  | { id: string; kind: 'browser'; token: string }
  | { id: string; kind: 'git'; token: string; command: GitCommand }
  | { id: string; kind: 'mcp'; token: string; server: string; name: string; tool?: string }
  | { id: string; kind: 'terminal'; token: string; name: string; tabId: string; cwd: string; selection?: string }
interface MentionEntry {
  id: string
  kind: MentionKind
  mode?: AgentMode
  git?: GitCommand
  name: string
  detail: string
  path?: string
  chatId?: string
  server?: string
  tool?: string
  tabId?: string
  cwd?: string
}
