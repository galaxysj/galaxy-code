import { artifactTitle, isScreenshotArtifact } from '@shared/artifacts'
import { TaskMark } from './TaskMark'
import {
  AppWindow,
  ArrowUp,
  Check,
  ChevronDown,
  CircleQuestionMark,
  File as FileIcon,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  Camera,
  CircleAlert,
  File,
  FileDiff,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  Laptop,
  ListTodo,
  Monitor,
  Paperclip,
  Plug,
  Plus,
  MessageCircle,
  MessageSquareText,
  MessagesSquare,
  Package,
  Play,
  Square,
  SquareTerminal,
  Sparkles,
  X,
  FoldVertical,
  Gauge
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react'
import type { AgentMode, Attachment, Chat, GitCommand, InstalledApp, Item, PermissionMode, ProjectFileEntry, PromptMentions, ResolvedModel, UsageReport, RevertedMessage, SkillInfo, ToolItem } from '@shared/types'
import { basename, cn, tildify } from '../lib/utils'
import { GIT_COMMAND_ICON, GIT_COMMANDS, gitCommandFor, gitToken, runGitCommand } from '../lib/gitCommands'
import { useActiveChat, useChatId, useRunConfig, useStore, type PanelTab } from '../store'
import { FileIcon as FileTypeIcon } from './ProjectFiles'
import { AcpOptions } from './AcpOptions'
import { FastIcon, ModelPicker, UltrafastIcon } from './ModelPicker'
import { ModelBrandIcon } from './SubscriptionIcon'
import { AUTO_MODEL, needsCredits, usesGalaxyTools } from '@shared/catalog'
import { SUBSCRIPTION_ACCOUNT } from '@shared/types'
import type { ModelBrand } from '@shared/models'
import { ApprovalPrompt } from './ApprovalPrompt'
import { SubscriptionPicker } from './SubscriptionPicker'
import { AppContextCard } from './AppContextCard'
import { buildComments, COMMENTS_MARKER, type ComposerComment } from '../lib/comments'
import { Button, IconButton, MenuItem, MenuSeparator, Popover, Segmented, SkillIcon, Spinner, TextInput } from './ui'
import { openLink } from '../lib/openLink'

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
                  {mode.value === 'auto' ? 'Approves routine work and asks you about risky actions.' : mode.description}
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

/** Everything in the one-line composer but the text and the model name: padding, gaps and the two round buttons. */
const COMPACT_CHROME = 100
/** Matches `.composer-compact .composer-model`. */
const COMPACT_MODEL_MAX = 260

const MODES: Record<AgentMode, { label: string; command: string; description: string; placeholder: string; icon: typeof Globe; tone: string }> = {
  ask: { label: 'Ask', command: 'ask', description: 'Answer questions with read-only tools. Nothing is changed.', placeholder: 'Ask questions', icon: CircleQuestionMark, tone: 'var(--green)' },
  plan: { label: 'Plan', command: 'plan', description: 'Research and write a plan before building.', placeholder: 'Describe what to plan', icon: FileText, tone: 'var(--orange)' },
  multitask: { label: 'Multitask', command: 'multitask', description: 'Split the request into tasks that subagents work on in parallel.', placeholder: 'Describe the tasks', icon: MessageCircle, tone: 'var(--purple)' }
}

/** Commands that open a side chat. Text after the command becomes its first message. */
const SIDE_COMMANDS = ['side', 'btw']
const MULTITASK_ULTRA = "Multitask can't be used with Ultra mode."
const SIDE_COMMAND = /^\/(?:side|btw)(?:\s+|$)/i

/** How full the context is, as a ring toward the point where history is compacted (90% of the window). Details on hover. */
function ContextRing({ used, size, subscription }: { used: number; size: number; subscription: string }): ReactNode {
  const limit = Math.floor(size * 0.9)
  const ratio = Math.min(1, used / limit)
  const radius = 6
  const circumference = 2 * Math.PI * radius
  const auto = usesGalaxyTools(subscription)
  const summary = `Context: ${used.toLocaleString()} of ${size.toLocaleString()} tokens (${Math.round((used / size) * 100)}%)`
  const hint = auto ? `Compacts automatically at ${limit.toLocaleString()} (90%). Type /compact to do it now.` : ''
  return (
    <span aria-label={`${summary}${hint ? `. ${hint}` : ''}`} className="group/ring relative mx-1 flex h-7 w-5 shrink-0 cursor-default items-center justify-center">
      <span className="pointer-events-none absolute bottom-full right-0 z-30 mb-1 w-max max-w-[280px] rounded-lg border border-line bg-elev px-2.5 py-1.5 text-[12px] leading-snug text-fg opacity-0 shadow-pop transition-opacity group-hover/ring:opacity-100">
        <span className="block tabular-nums">{summary}</span>
        {hint && <span className="mt-0.5 block text-muted">{hint}</span>}
      </span>
      <svg width="16" height="16" viewBox="0 0 16 16" className="-rotate-90">
        <circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeWidth="2" className="text-line-strong" />
        <circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - ratio)} className={ratio >= 0.85 ? 'text-warn' : 'text-subtle'} />
      </svg>
    </span>
  )
}

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
    if (chip.kind === 'computer') return [{ id, kind: 'computer', token: chip.token }]
    if (chip.kind === 'app') {
      const entry = mentions.apps?.find(({ name }) => name === chip.label)
      return entry ? [{ id: `app:${entry.path}`, kind: 'app', token: chip.token, name: entry.name, path: entry.path, icon: chip.icon }] : []
    }
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
      return skill ? [{ id, kind: 'skill', token: chip.token, name: skill.name, displayName: chip.displayName, path: skill.path, icon: chip.icon, color: chip.color }] : []
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
  const settingsOpen = useStore((s) => s.settingsOpen !== null)
  const key = edit?.key ?? chat?.id ?? 'new'
  const text = useStore((s) => s.composerText[key] ?? '')
  const attachments = useStore((s) => s.composerAttachments[key]) ?? EMPTY
  const comments = useStore((s) => s.composerComments[key]) ?? NO_COMMENTS
  const setComments = useStore((s) => s.setComposerComments)
  const setText = useStore((s) => s.setComposerText)
  const setAttachments = useStore((s) => s.setComposerAttachments)
  const send = useStore((s) => s.send)
  const openSideChat = useStore((s) => s.openSideChat)
  const runConfig = useRunConfig()
  const { model, subscription, acp } = runConfig
  const models = useStore((s) => s.models)
  const pickModel = useStore((s) => s.pickModel)
  const setAcpOption = useStore((s) => s.setAcpOption)
  const setRunOptions = useStore((s) => s.setRunOptions)
  const [usageBubble, setUsageBubble] = useState<string | null>(null)
  const chatId = useChatId()
  // Galaxy Code's own tools enforce the modes; ACP agents take Ask and Plan as their own modes and multitask with Galaxy's Agent tool.
  const galaxyTools = usesGalaxyTools(model?.subscription)
  const modesAvailable = galaxyTools || !!acp
  // The error that stopped the last run stays above the box, with no Continue or Commit chips beside it, until it is dismissed or a message is sent.
  const [dismissedError, setDismissedError] = useState<string | null>(null)
  const errorKey = chat?.error ? `${chat.id}:${chat.updatedAt}:${chat.error}` : null
  const errorShown = !edit && !!errorKey && errorKey !== dismissedError && chat?.status !== 'running'
  const storedMode = useStore((s) => s.composerMode[key])
  const setComposerMode = useStore((s) => s.setComposerMode)
  const mode = modesAvailable ? storedMode : undefined
  // /compact summarizes a Galaxy model's history; account and ACP agents keep their own context.
  const canCompact = !edit && !!chat && galaxyTools
  const compactChat = (): void => {
    if (!chat) return
    void window.galaxy.chats.compact(chat.id).catch((error: unknown) => useStore.getState().notify(String(error instanceof Error ? error.message : error), 'error'))
  }
  // Multitask hides Ultra, so the composer stops showing it too.
  const ultra = runConfig.ultra && mode !== 'multitask'
  const textarea = useRef<HTMLTextAreaElement>(null)
  const wrapProbe = useRef<HTMLDivElement>(null)
  const modelSlot = useRef<HTMLSpanElement>(null)
  const messageBox = useRef<HTMLDivElement>(null)
  const layoutSnapshot = useRef<{ key: string; compact: boolean; height: number; positions: Map<Element, DOMRect> } | null>(null)
  const layoutAnimations = useRef<Animation[]>([])
  const [wrapped, setWrapped] = useState(false)
  const [mention, setMention] = useState<{ trigger: '/' | '@'; start: number; end: number; query: string } | null>(null)
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [mentionFiles, setMentionFiles] = useState<ProjectFileEntry[]>([])
  const [mentionApps, setMentionApps] = useState<InstalledApp[]>([])
  const computerUse = useStore((s) => s.settings.computerUse)
  const ultraMode = useStore((s) => s.settings.ultraMode !== false)
  const [mentionIndex, setMentionIndex] = useState(0)
  useEffect(() => {
    if (settingsOpen) {
      setMention(null)
      setMentionIndex(0)
    }
  }, [settingsOpen])
  const [selectedMentions, setSelectedMentions] = useState<SelectedMention[]>(() => selectedFrom(edit?.message.mentions))
  // Mentions added from elsewhere, such as Add to Chat in a terminal, go at the end of the message.
  useEffect(() => {
    if (edit || chat?.side || mentionQueue.length === 0) return
    const queued = useStore.getState().takeMentions()
    let current = useStore.getState().composerText[key] ?? ''
    const added: SelectedMention[] = []
    for (const item of queued) {
      if (item.kind === 'skill') {
        const { skill } = item
        const token = `@ ${skill.displayName ?? skill.name}`
        added.push({ id: `skill:${skill.path}`, kind: 'skill', token, name: skill.name, displayName: skill.displayName, path: skill.path, icon: skill.icon, color: skill.brandColor })
        current = `${current}${current && !/\s$/.test(current) ? ' ' : ''}${token} ${item.text}`
        continue
      }
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
      // The comment list at the end of the text comes back as comments, not as text.
      const sent = edit.message.mentions?.comments ?? []
      const cut = sent.length ? edit.message.text.indexOf(COMMENTS_MARKER) : -1
      setText(edit.key, cut >= 0 ? edit.message.text.slice(0, cut).trim() : edit.message.text)
      setAttachments(edit.key, edit.message.attachments)
      if (sent.length) state.setComposerComments(edit.key, sent.map((comment) => ({ ...comment, id: crypto.randomUUID() })))
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
  const hasOwnMessage = !chat?.side || (items ?? []).some((item) => item.kind === 'user' && !item.parentId)
  const followUp = !!chat && !edit && hasOwnMessage
  const compact = followUp && !text.includes('\n') && !wrapped && attachments.length === 0 && comments.length === 0 && !acp && !mode
  const canSend = (text.trim().length > 0 || attachments.length > 0 || comments.length > 0) && !!model

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

  // Apps only come up for a search: a Mac has too many to list under a bare @.
  useEffect(() => {
    const query = mention?.trigger === '@' && computerUse ? mention.query.trim() : ''
    if (!query) {
      setMentionApps([])
      return
    }
    let current = true
    void window.galaxy.computer.searchApps(query).then((apps) => { if (current) setMentionApps(apps) }).catch(() => { if (current) setMentionApps([]) })
    return () => { current = false }
  }, [mention?.trigger, mention?.query, computerUse])

  const terminalTabs = panelTabs.filter((tab): tab is Extract<PanelTab, { type: 'terminal' }> => tab.type === 'terminal' && !terminalOutput[tab.id]?.exited)
  const recentChats = Object.values(chats)
    .filter((entry) => entry.id !== activeChatId && !entry.side)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  // An ACP agent's / entries that share a name with one of Galaxy Code's give way to Galaxy Code's.
  const squash = (value: string): string => value.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
  const galaxyCommands = new Set([
    ...(modesAvailable ? (Object.keys(MODES) as AgentMode[]).flatMap((value) => [MODES[value].label, MODES[value].command]) : []),
    ...(canCompact ? ['compact'] : []),
    ...(model?.fastMode ? ['fast'] : []),
    ...(model?.ultrafastMode ? ['ultrafast'] : []),
    'usage',
    ...(!edit ? ['Side Chat', ...SIDE_COMMANDS] : []),
    ...skills.flatMap((skill) => [skill.name, ...(skill.displayName ? [skill.displayName] : [])])
  ].map(squash))
  const mentionEntries: MentionEntry[] = mention?.trigger === '/'
    ? [
        ...(modesAvailable ? (Object.keys(MODES) as AgentMode[]) : [])
          .filter((value) => MODES[value].command.startsWith(mention.query.toLowerCase()))
          .map((value) => {
            const disabled = value === 'multitask' && ultra
            return { id: `mode:${value}`, kind: 'mode' as const, name: MODES[value].label, detail: disabled ? MULTITASK_ULTRA : MODES[value].description, mode: value, disabled }
          }),
        ...(canCompact && 'compact'.startsWith(mention.query.toLowerCase())
          ? [{ id: 'command:compact', kind: 'command' as const, name: 'Compact', detail: 'Summarize the conversation so far to free up context.' }]
          : []),
        ...(model?.fastMode && 'fast'.startsWith(mention.query.toLowerCase())
          ? [{ id: 'command:fast', kind: 'command' as const, name: 'Fast', detail: runConfig.fast && !runConfig.ultrafast ? 'Turn Fast off.' : 'Turn Fast on.' }]
          : []),
        ...(model?.ultrafastMode && 'ultrafast'.startsWith(mention.query.toLowerCase())
          ? [{ id: 'command:ultrafast', kind: 'command' as const, name: 'Ultrafast', detail: runConfig.ultrafast ? 'Turn Ultrafast off.' : 'Turn Ultrafast on.' }]
          : []),
        ...('usage'.startsWith(mention.query.toLowerCase())
          ? [{ id: 'command:usage', kind: 'command' as const, name: 'Usage', detail: 'See your credits, plan limits and spend.' }]
          : []),
        ...(!edit && SIDE_COMMANDS.some((command) => command.startsWith(mention.query.toLowerCase()))
          ? [{ id: 'command:side', kind: 'command' as const, name: 'Side Chat', detail: 'Open a side chat in the panel. It is deleted when closed.' }]
          : []),
        // An ACP agent's own modes and models, from the options it reports.
        ...(acp?.options ?? [])
          .filter((option) => option.category === 'mode' || option.category === 'model')
          .flatMap((option) => option.options.map((choice) => ({ option, choice })))
          .filter(({ choice }) => !galaxyCommands.has(squash(choice.name)) && !galaxyCommands.has(squash(choice.value)))
          .filter(({ choice }) => !mention.query || `${choice.name} ${choice.value}`.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase().includes(mention.query.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()))
          .sort((a, b) => (a.option.category === 'mode' ? 0 : 1) - (b.option.category === 'mode' ? 0 : 1))
          .map(({ option, choice }) => {
            const selected = (acp?.values[option.id] ?? option.currentValue) === choice.value
            return {
              id: `acp:${option.id}:${choice.value}`,
              kind: option.category === 'mode' ? ('mode' as const) : ('model' as const),
              name: choice.name,
              detail: selected ? `${option.name} · Selected` : (choice.description ?? `Switch ${option.name.toLowerCase()}`),
              acpOption: option.id,
              acpValue: choice.value
            }
          }),
        ...models
          .filter((entry) => !acp && entry.enabled && entry.subscription === subscription &&
            (!mention.query || `${entry.name} ${entry.id}`.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase().includes(mention.query.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase())))
          .map((entry) => ({ id: `model:${entry.key}`, kind: 'model' as const, brand: entry.brand, name: entry.name, detail: entry.key === model?.key ? `${entry.name} · Selected` : `Switch to ${entry.name}`, modelKey: entry.key })),
        ...skills.filter((skill) => `${skill.displayName ?? ''} ${skill.name} ${skill.description}`.toLowerCase().includes(mention.query.toLowerCase())).map((skill) => ({ id: `skill:${skill.path}`, kind: 'skill' as const, name: skill.name, detail: skill.description || skill.scope, path: skill.path, displayName: skill.displayName, icon: skill.icon, color: skill.brandColor }))
      ]
    : mention?.trigger === '@'
      ? [
          { id: 'upload', kind: 'upload' as const, name: 'Add files or photos', detail: 'Upload attachments from your computer.' },
          ...skills.map((skill) => ({ id: `skill:${skill.path}`, kind: 'skill' as const, name: skill.name, detail: skill.description || skill.scope, path: skill.path, displayName: skill.displayName, icon: skill.icon, color: skill.brandColor })),
          { id: 'browser', kind: 'browser' as const, name: 'Browser', detail: 'Use the in-app browser for this task.' },
          { id: 'computer', kind: 'computer' as const, name: 'Computer', detail: useStore.getState().settings.computerUse ? 'Work in other apps in the background.' : 'Turn this on in Settings > Computer Use.' },
          ...mentionApps.map((entry) => ({ id: `app:${entry.path}`, kind: 'app' as const, name: entry.name, detail: entry.path, path: entry.path, icon: entry.icon })),
          ...(Object.keys(GIT_COMMANDS) as GitCommand[]).map((command) => ({ id: `git:${command}`, kind: 'git' as const, name: GIT_COMMANDS[command].label, detail: GIT_COMMANDS[command].detail, git: command })),
          ...mcp.filter((server) => server.state === 'ready').map((server) => ({ id: `mcp:${server.id}`, kind: 'mcp' as const, name: mcpServers.find((config) => config.id === server.id)?.name ?? server.id, detail: `${server.tools.length} tools`, server: server.id })),
          ...terminalTabs.map((tab) => ({ id: `terminal:${tab.id}`, kind: 'terminal' as const, name: tab.customTitle || tab.title, detail: tab.cwd, tabId: tab.id, cwd: tab.cwd })),
          ...recentChats.slice(0, 12).map((entry) => ({ id: `chat:${entry.id}`, kind: 'chat' as const, name: entry.title || 'Untitled chat', detail: '', chatId: entry.id })),
          ...mentionFiles.map((file) => ({ id: `file:${file.path}`, kind: 'file' as const, name: file.relativePath.split('/').pop() ?? file.relativePath, detail: file.relativePath.includes('/') ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/')) : '', path: file.path }))
        ].filter((entry: MentionEntry) => !mention.query || entry.kind === 'file' || `${entry.displayName ?? ''} ${entry.name}`.toLowerCase().includes(mention.query.toLowerCase()))
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
    if (entry.disabled) return
    if (entry.acpOption && entry.acpValue !== undefined) {
      replaceMention('')
      setAcpOption(entry.acpOption, entry.acpValue, chatId)
      return
    }
    if (entry.kind === 'model' && entry.modelKey) {
      pickModel(entry.modelKey, chatId)
      replaceMention('')
      return
    }
    if (entry.id === 'command:compact') {
      replaceMention('')
      compactChat()
      return
    }
    if (entry.id === 'command:fast') {
      replaceMention('')
      setRunOptions({ fast: !runConfig.fast || runConfig.ultrafast, ultrafast: false }, chatId)
      return
    }
    if (entry.id === 'command:ultrafast') {
      replaceMention('')
      setRunOptions({ fast: !runConfig.ultrafast, ultrafast: !runConfig.ultrafast }, chatId)
      return
    }
    if (entry.id === 'command:usage') {
      replaceMention('')
      // The home screen has no chat for the bubble to speak for.
      if (!chat) {
        useStore.setState({ settingsOpen: 'usage' })
        return
      }
      setUsageBubble('Checking usage…')
      void window.galaxy.settings.usage().then((report) => {
        const { secrets, settings } = useStore.getState()
        setUsageBubble(usageSummary(report, model, !!model && !needsCredits(model, secrets, settings)))
      }).catch(() => setUsageBubble('Could not check usage'))
      return
    }
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
    const token = `@ ${entry.displayName ?? entry.name}`
    let selected: SelectedMention | null = null
    if (entry.kind === 'skill' && entry.path) selected = { id: entry.id, kind: 'skill', token, name: entry.name, displayName: entry.displayName, path: entry.path, icon: entry.icon, color: entry.color }
    else if (entry.kind === 'file' && entry.path) selected = { id: entry.id, kind: 'file', token, name: entry.name, path: entry.path }
    else if (entry.kind === 'chat' && entry.chatId) selected = { id: entry.id, kind: 'chat', token, name: entry.name, chatId: entry.chatId }
    else if (entry.kind === 'browser') selected = { id: entry.id, kind: 'browser', token }
    else if (entry.kind === 'computer') selected = { id: entry.id, kind: 'computer', token }
    else if (entry.kind === 'app' && entry.path) selected = { id: entry.id, kind: 'app', token, name: entry.name, path: entry.path, icon: entry.icon }
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
    // The one-line box gives the text what the buttons and the model name leave over.
    const model = Math.min(modelSlot.current?.getBoundingClientRect().width ?? 0, COMPACT_MODEL_MAX)
    probe.style.width = `max(1px, calc(100% - ${COMPACT_CHROME + model}px))`
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
    if (modelSlot.current) observer.observe(modelSlot.current)
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

  // App Context attaches through the store, and the user will want to type about it right away.
  useEffect(() => {
    if (edit) return
    return window.galaxy.onUiEvent((event) => { if (event.type === 'app-context' && event.attachments.length) textarea.current?.focus() })
  }, [edit])

  // A comment box's Send button asks this composer to send, once its comments have reached it.
  const sendRequest = useStore((s) => s.composerSend)
  const submitRef = useRef<(steer?: boolean) => Promise<void>>(async () => {})
  useEffect(() => {
    if (edit || sendRequest !== key) return
    useStore.setState({ composerSend: null })
    void submitRef.current()
  }, [sendRequest, key, edit])
  const submit = async (steer = false): Promise<void> => {
    if (!canSend) return
    if (!edit && /^\/compact\s*$/i.test(text.trim()) && canCompact) {
      setText(key, '')
      setMention(null)
      compactChat()
      return
    }
    const side = edit ? null : SIDE_COMMAND.exec(text)
    if (side) {
      setText(key, '')
      setSelectedMentions([])
      setMention(null)
      void openSideChat(text.slice(side[0].length), chat?.id)
      return
    }
    let outgoing = text
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
    // A typed @commit, @commit-push or @push works like the picked one.
    const git = selected.find((item) => item.kind === 'git')?.command ?? (/^@(commit-push|commit|push)(?=\s|$)/.exec(outgoing.trim())?.[1] as GitCommand | undefined)
    const mentions: PromptMentions = {
      ...(git ? { git } : {}),
      skills: selected.flatMap((item) => item.kind === 'skill' ? [{ name: item.name, path: item.path }] : []),
      files: selected.flatMap((item) => item.kind === 'file' ? [{ name: item.name, path: item.path }] : []),
      chats: mentionedChats,
      browser: selected.some((item) => item.kind === 'browser'),
      computer: selected.some((item) => item.kind === 'computer'),
      apps: selected.flatMap((item) => item.kind === 'app' ? [{ name: item.name, path: item.path }] : []),
      appContexts: attachments.flatMap(({ appContext }) => appContext?.tree ? [{ app: appContext.app, tree: appContext.tree }] : []),
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
        label: item.kind === 'browser' ? 'Browser' : item.kind === 'computer' ? 'Computer' : item.kind === 'git' ? GIT_COMMANDS[item.command].label : item.name,
        ...(item.kind === 'file' ? { title: item.path } : {}),
        ...(item.kind === 'app' ? { title: item.path, icon: item.icon } : {}),
        ...(item.kind === 'skill' ? { displayName: item.displayName, icon: item.icon, color: item.color } : {}),
        ...(item.kind === 'terminal' ? { title: item.selection ? item.selection.slice(0, 400) : item.cwd } : {}),
        ...(item.kind === 'mcp' && !item.tool ? { title: item.server } : {})
      }))
    }
    let files = attachments
    // Comments go after the message, and the pictures they point at go with it, each area numbered as in the text.
    if (comments.length) {
      try {
        const built = await buildComments(comments)
        const pictures = await Promise.all(built.images.map((image) => window.galaxy.files.attachFromData(image.name, 'image/png', image.dataUrl.slice(image.dataUrl.indexOf(',') + 1))))
        files = [...attachments, ...pictures]
        outgoing = [outgoing.trim(), built.text].filter(Boolean).join('\n\n')
        mentions.comments = comments.map(({ source, detail, note }) => ({ source, detail, note }))
        setComments(key, [])
      } catch (error) {
        useStore.getState().notify(String(error), 'error')
        return
      }
    }
    setText(key, '')
    setAttachments(key, [])
    setSelectedMentions([])
    setMention(null)
    void send(outgoing, files, mentions, steer, mode, undefined, chat?.id ?? null)
  }

  submitRef.current = submit

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
    <div className={cn(!edit && 'chat-column mx-auto w-full px-6', !edit && (centered ? 'max-w-[680px] pb-0' : 'max-w-[780px] pb-4'))}>

      {errorShown && chat?.error && <ChatError message={chat.error} onDismiss={() => setDismissedError(errorKey)} />}

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

      {/* Just above the box, below any suggestion chips and queued messages. The shortcuts stay in the compact one-line input too, where the chips are left out. */}
      {!edit && !chat?.side && (!compact || chat) && (
        <div className="relative mb-1.5 flex min-h-6 items-center gap-1.5 pl-1">
          {/* Everything at the left shrinks and clips, so it never runs under the shortcuts. Bubbles wait while the agent runs; the task bar shows only then. */}
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden py-1.5 -my-1.5 pr-2">
          {!compact && !chat && <ProjectChip chat={chat} />}
          {!compact && <WorkspaceToggle chat={chat} />}
          {usageBubble && !running && (
            <div className="group/att relative flex min-w-0 max-w-full">
              <button type="button" title="Open usage in Settings" onClick={() => { setUsageBubble(null); useStore.setState({ settingsOpen: 'usage' }) }} className={SUGGESTION_CHIP}>
                <Gauge size={13.5} className="shrink-0" />
                <span className="min-w-0 truncate">{usageBubble}</span>
              </button>
              <button type="button" title="Dismiss" onClick={() => setUsageBubble(null)} className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-fg text-bg opacity-0 transition-opacity group-hover/att:opacity-100">
                <X size={10} strokeWidth={3} />
              </button>
            </div>
          )}
          {/* The task in progress shares the row too, so it sits on the box like the chips. */}
          {chat && !(usageBubble && !running) && <CurrentTask chat={chat} items={items} />}
          {/* The suggestion chips share this row, at the left, with the shortcuts at the right. */}
          {followUp && chat && !chat.side && !errorShown && !running && <ChatChips chat={chat} items={items} />}
          </div>
          {chat && <PanelShortcuts chat={chat} />}
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
        {!settingsOpen && mention && mentionEntries.length > 0 && (
          <div ref={mentionList} role="listbox" aria-label={mention.trigger === '/' ? 'Commands' : 'Mentions'} className={cn('absolute left-2 right-2 z-40 max-h-80 overflow-y-auto flex flex-col gap-0.5 rounded-2xl border border-line bg-elev p-2 shadow-pop', edit ? 'top-full mt-2' : 'bottom-full mb-2')}>
            {mentionEntries.map((entry, index) => {
              const Icon = entry.mode ? MODES[entry.mode].icon : entry.git ? GIT_COMMAND_ICON[entry.git] : COMMAND_ICON[entry.id] ?? CHIP_ICON[entry.kind]
              const heading = index === 0 || MENU_HEADINGS[mentionEntries[index - 1].kind] !== MENU_HEADINGS[entry.kind] ? MENU_HEADINGS[entry.kind] : null
              return (
                <div key={entry.id} role="presentation">
                {heading && <div className={cn('px-3 pb-1 text-[11px] font-medium text-subtle', index > 0 ? 'pt-2.5' : 'pt-1')}>{heading}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === mentionIndex}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseMention(entry)}
                  aria-disabled={entry.disabled || undefined}
                  title={entry.detail || undefined}
                  onMouseMove={() => { if (index !== mentionIndex) setMentionIndex(index) }}
                  className={cn('flex h-9.5 w-full min-w-0 items-center gap-3 rounded-lg px-3 text-left', index === mentionIndex ? 'bg-hover text-fg' : 'text-muted', entry.disabled && 'cursor-default opacity-40')}
                >
                  <span className="flex w-4 shrink-0 justify-center">{entry.id === 'command:fast' ? <FastIcon size={14} /> : entry.id === 'command:ultrafast' ? <UltrafastIcon size={14} /> : entry.kind === 'app' && entry.icon ? <img src={entry.icon} alt="" width={22} height={22} className="max-w-none shrink-0" /> : entry.kind === 'model' && entry.brand ? <ModelBrandIcon brand={entry.brand} /> : entry.kind === 'file' ? <FileTypeIcon name={entry.name} /> : entry.kind === 'skill' ? <SkillIcon icon={entry.icon} color={entry.color} size={15} fallback={<Icon size={15} className={entry.color ? undefined : 'text-subtle'} />} /> : <Icon size={15} className="text-subtle" />}</span>
                  <span className="flex min-w-0 flex-1 items-baseline gap-2.5">
                    <span className="max-w-[60%] shrink-0 truncate text-[13px] text-fg">{entry.displayName ?? entry.name}</span>
                    <span className="min-w-0 truncate text-[11.5px] text-subtle">{entry.detail}</span>
                  </span>
                </button>
                </div>
              )
            })}
          </div>
        )}
        {comments.length > 0 && <CommentsCard comments={comments} onChange={(next) => setComments(key, next)} />}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3.5 pt-3.5">
            {attachments.map((file) => {
              const remove = (): void => setAttachments(key, attachments.filter((entry) => entry.id !== file.id))
              return file.appContext
                ? <AppContextCard key={file.id} file={file} onOpen={(entry) => useStore.getState().openAttachment(entry)} onRemove={remove} />
                : <AttachmentChip key={file.id} file={file} onRemove={remove} />
            })}
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
          className={cn('relative block max-h-[40vh] w-full resize-none', centered ? 'min-h-[80px]' : 'min-h-[44px]', 'bg-transparent px-4 pb-1 pt-3.5 text-[14.7px] leading-[1.55] placeholder:text-subtle', chipTokens.length > 0 && 'text-transparent caret-[var(--fg)]')}
        />
        </div>
        <div className="composer-toolbar flex flex-wrap items-center gap-0.5 px-2 pb-2 pt-1">
          <div className="composer-options flex min-w-0 flex-wrap items-center gap-0.5">
            <AddMenu onAdd={insertMention} />
            {mode && <ModeChip mode={mode} onClear={() => { setComposerMode(key, undefined); textarea.current?.focus() }} />}
            {/* ACP agents bring their own session options. The model picker shows their model and effort; the rest sit here. */}
            {acp && <AcpOptions />}
          </div>
          <div className="composer-actions ml-auto flex min-w-0 max-w-full items-center">
            <span ref={modelSlot} className="composer-model flex min-w-0 items-center"><ModelPicker noUltra={mode === 'multitask' || !ultraMode} /></span>
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
        {chat && model && <span className="ml-auto flex"><ContextRing used={chat.usage.contextTokens} size={runConfig.context ?? 200_000} subscription={model.subscription} /></span>}
      </div>
    </div>
  )
}

const EMPTY: Attachment[] = []
const NO_COMMENTS: ComposerComment[] = []

/** The comments waiting to be sent, as one card; opening it lists them, each removable. */
function CommentsCard({ comments, onChange }: { comments: ComposerComment[]; onChange(next: ComposerComment[]): void }): ReactNode {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  return (
    <div className="px-3.5 pt-3.5">
      <div ref={anchor} className="inline-flex h-10 items-center whitespace-nowrap rounded-2xl border border-line bg-bg text-[13.5px] font-medium text-fg">
        <button type="button" onClick={() => setOpen((value) => !value)} className="flex h-full items-center gap-2.5 rounded-l-2xl pl-3.5 pr-2 hover:bg-hover">
          <MessageSquareText size={15} className="text-muted" />
          {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
        </button>
        <button type="button" title="Remove all comments" onClick={() => { onChange([]); setOpen(false) }} className="mr-1.5 flex h-6 w-6 items-center justify-center rounded-full text-subtle hover:bg-active hover:text-fg"><X size={14} /></button>
      </div>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="top-start">
        <div className="max-h-[280px] w-[340px] overflow-y-auto p-1">
          {comments.map((comment, index) => (
            <div key={comment.id} className="group/comment flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-hover">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded bg-[#ff3b30] text-[10px] font-semibold text-white">{index + 1}</span>
              <div className="min-w-0 flex-1 text-[12.5px]">
                <div className="truncate text-[11.5px] text-subtle">{comment.source}{comment.detail ? ` · ${comment.detail}` : ''}</div>
                <div className="whitespace-pre-wrap break-words text-fg">{comment.note}</div>
              </div>
              <button type="button" title="Remove comment" onClick={() => { const next = comments.filter((entry) => entry.id !== comment.id); onChange(next); if (!next.length) setOpen(false) }} className="shrink-0 rounded p-0.5 text-subtle hover:bg-active hover:text-fg"><X size={13} /></button>
            </div>
          ))}
        </div>
      </Popover>
    </div>
  )
}

/** Why the last run stopped, above the message box. */
function ChatError({ message, onDismiss }: { message: string; onDismiss: () => void }): ReactNode {
  return (
    <div role="alert" className="mb-2 flex items-start gap-2.5 rounded-xl bg-elev px-3 py-2.5 text-[12.5px] leading-snug text-muted shadow-composer">
      <CircleAlert size={15} className="mt-px shrink-0 text-fg" />
      <div className="max-h-32 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words">
        {message.split(/(https?:\/\/\S+)/g).map((part, index) =>
          /^https?:\/\//.test(part) ? <a key={index} href={part} onClick={(event) => { event.preventDefault(); void openLink(part, event) }} className="text-link underline">{part}</a> : part
        )}
      </div>
      <button type="button" title="Dismiss" onClick={onDismiss} className="mt-0.5 shrink-0 text-muted transition-colors hover:text-fg">
        <X size={13} />
      </button>
    </div>
  )
}

/** Round chips above the box mid-chat: Continue after a stopped turn, and Commit while the folder has uncommitted changes. */
/** The suggestion bubbles above the message box. */
const SUGGESTION_CHIP = 'flex h-7.5 min-w-0 items-center gap-1.5 rounded-full bg-elev px-3 text-[12.5px] text-fg shadow-composer transition-colors hover:bg-hover'

function ChatChips({ chat, items }: { chat: Chat; items: Item[] | undefined }): ReactNode {
  const cwd = useStore((s) => chat.worktree?.path ?? s.projects.find((entry) => entry.id === chat.projectId)?.path)
  const [git, setGit] = useState<{ dirty: boolean; hasRemote: boolean } | null>(null)
  const [committing, setCommitting] = useState<GitCommand | null>(null)
  const [recheck, setRecheck] = useState(0)
  const idle = chat.status !== 'running' && chat.status !== 'awaiting'
  // Recheck whenever the agent finishes, since a turn may have edited or committed files.
  useEffect(() => {
    if (!cwd || !idle) return
    let cancelled = false
    void window.galaxy.review.state(cwd).then((value) => { if (!cancelled) setGit(value.isRepo ? value : null) }).catch(() => { if (!cancelled) setGit(null) })
    return () => { cancelled = true }
  }, [cwd, idle, chat.updatedAt, recheck])
  if (!idle) return null
  const last = (items ?? []).findLast((item) => !item.parentId && (item.kind === 'turn' || item.kind === 'user'))
  const stopped = chat.status === 'error' || last?.kind === 'turn' && !!last.interrupted
  const commands: GitCommand[] = !git?.dirty ? [] : git.hasRemote ? ['commit', 'commit-push'] : ['commit']
  if (!stopped && !commands.length) return null
  const chip = SUGGESTION_CHIP
  return (
    <div className="flex min-w-0 items-center gap-2">
      {stopped && (
        <button type="button" title="Have the agent pick up where it stopped" onClick={() => void useStore.getState().send('Continue', [], undefined, false, undefined, undefined, chat.id)} className={chip}>
          <Play size={12.5} />
          Continue
        </button>
      )}
      {commands.map((command) => (
        <button
          key={command}
          type="button"
          title={GIT_COMMANDS[command].detail}
          disabled={committing !== null}
          onClick={() => {
            setCommitting(command)
            void runGitCommand(command, chat.id, cwd).finally(() => { setCommitting(null); setRecheck((value) => value + 1) })
          }}
          className={chip}
        >
          {committing === command ? <Spinner size={12} /> : (() => { const Icon = GIT_COMMAND_ICON[command]; return <Icon size={13.5} /> })()}
          {GIT_COMMANDS[command].label}
        </button>
      ))}
    </div>
  )
}

/** Review, terminal and files in the side panel, at the top right of the input. */
type ShortcutCard = 'diff' | 'terminal' | 'files'

function CardRow({ onClick, children }: { onClick(): void; children: ReactNode }): ReactNode {
  return (
    <button type="button" onClick={onClick} className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[12.5px] transition-colors hover:bg-hover">
      {children}
    </button>
  )
}

/** The files this conversation changed, folder in faint small text after the name, +added -removed at the right end. */
function DiffCard({ root, items, dirty }: { root: string | null; items: Item[] | undefined; dirty: Set<string> | null }): ReactNode {
  const openFile = useStore((s) => s.openFile)
  const totals = new Map<string, { added: number; removed: number }>()
  for (const item of items ?? []) {
    if (item.kind !== 'tool' || item.status !== 'done') continue
    for (const diff of item.meta?.diffs ?? []) {
      // Committed files are no longer changes: in a git project only the files still uncommitted are listed.
      if (artifactTitle(diff.path) || (dirty && !dirty.has(diff.path))) continue
      const sum = totals.get(diff.path) ?? { added: 0, removed: 0 }
      totals.set(diff.path, { added: sum.added + diff.added, removed: sum.removed + diff.removed })
    }
  }
  const rows = [...totals]
  // Inside the project: the folder from the project root, left out for a file at the root. Outside: the whole folder path.
  const folderOf = (path: string): string => {
    const dir = path.slice(0, path.lastIndexOf('/'))
    if (root && path.startsWith(`${root}/`)) return dir === root ? '' : dir.slice(root.length + 1)
    return dir
  }
  if (rows.length === 0) return <div className="px-3 py-4 text-center text-[12px] text-subtle">No changes in this conversation yet.</div>
  return (
    <>
      {rows.map(([path, sum]) => (
        <CardRow key={path} onClick={() => openFile(path)}>
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium text-fg">{basename(path)}</span>
            {folderOf(path) && <span className="ml-2 text-[11px] text-subtle">{folderOf(path)}</span>}
          </span>
          <span className="shrink-0 font-mono text-[11.5px] tabular-nums">
            <span className="text-ok">+{sum.added}</span> <span className="text-danger">-{sum.removed}</span>
          </span>
        </CardRow>
      ))}
    </>
  )
}

type ShellRow = { id: string; name: string; log: string; exited: boolean; code: number | null }

/** The agent's background commands. Clicking one opens its output in the side panel, read-only; Stop ends it. */
function ProcessCard({ chatId, shells, stoppingAll }: { chatId: string; shells: ShellRow[] | null; stoppingAll: boolean }): ReactNode {
  const openFile = useStore((s) => s.openFile)
  const [stopping, setStopping] = useState<Set<string>>(new Set())
  if (!shells) return <div className="flex justify-center py-4"><Spinner size={14} className="text-subtle" /></div>
  if (shells.length === 0) return <div className="px-3 py-4 text-center text-[12px] text-subtle">No background processes.</div>
  return (
    <>
      {shells.map((shell) => (
        <div key={shell.id} className="flex h-8 w-full min-w-0 items-center rounded-lg transition-colors hover:bg-hover">
          <button type="button" onClick={() => { openFile(shell.log); useStore.getState().updatePanelTab(shell.log, { customTitle: shell.name }) }} className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2 text-left text-[12.5px]">
            <SquareTerminal size={13.5} className="shrink-0 text-subtle" />
            <span className="min-w-0 flex-1 truncate text-fg">{shell.name}</span>
            <span className={cn('shrink-0 text-[11.5px]', shell.exited || stopping.has(shell.id) || stoppingAll ? 'text-subtle' : 'text-ok')}>{shell.exited ? (shell.code ? `Exited ${shell.code}` : 'Exited') : stopping.has(shell.id) || stoppingAll ? 'Stopping...' : 'Running'}</span>
          </button>
          <span className="flex w-14 shrink-0 justify-end pr-1.5">
            {!shell.exited && !stopping.has(shell.id) && !stoppingAll && <button type="button" onClick={() => { setStopping((current) => new Set(current).add(shell.id)); void window.galaxy.files.stopShells(chatId, shell.id) }} className="h-5 rounded px-1.5 text-[11px] text-muted hover:bg-active hover:text-fg">Stop</button>}
          </span>
        </div>
      ))}
    </>
  )
}

/** Every artifact of the conversation; clicking opens it in the side panel. */
function ArtifactCard({ chat }: { chat: Chat }): ReactNode {
  const openFile = useStore((s) => s.openFile)
  const [files, setFiles] = useState<{ path: string; title: string | null }[] | null>(null)
  useEffect(() => { void window.galaxy.files.artifacts(chat.id).then(setFiles).catch(() => setFiles([])) }, [chat.id])
  if (!files) return <div className="flex justify-center py-4"><Spinner size={14} className="text-subtle" /></div>
  if (files.length === 0) return <div className="px-3 py-4 text-center text-[12px] text-subtle">No artifacts yet.</div>
  return (
    <>
      {files.map((file) => {
        const label = file.title ?? artifactTitle(file.path) ?? basename(file.path)
        const Icon = artifactTitle(file.path) === 'Plan' ? FileText : artifactTitle(file.path) === 'Task' ? ListTodo : isScreenshotArtifact(file.path) ? Camera : File
        return (
          <CardRow key={file.path} onClick={() => openFile(file.path)}>
            <Icon size={13.5} className="shrink-0 text-subtle" />
            <span className="min-w-0 flex-1 truncate text-fg">{label}</span>
          </CardRow>
        )
      })}
    </>
  )
}

/** Review, terminal and files at the top right of the input: each opens a card above it with a preview. */
function PanelShortcuts({ chat }: { chat: Chat }): ReactNode {
  const project = useStore((s) => s.projects.find((p) => p.id === chat.projectId))
  const items = useStore((s) => s.items[chat.id])
  const root = chat.worktree?.path ?? project?.path ?? null
  // Files still uncommitted in the project, to drop a change once it is committed. Null outside a git project.
  const [dirty, setDirty] = useState<Set<string> | null>(null)
  const refreshDirty = useCallback((): void => {
    if (!root) return
    void window.galaxy.review.read(root).then((review) => setDirty(review.isRepo ? new Set(review.diffs.map((diff) => (diff.path.startsWith('/') ? diff.path : `${root}/${diff.path}`))) : null)).catch(() => setDirty(null))
  }, [root])
  useEffect(refreshDirty, [refreshDirty, chat.status, items?.length])
  // Files this conversation changed, from the edits already in the chat, that are still uncommitted; artifacts do not count.
  const changes = new Set((items ?? []).flatMap((item) => (item.kind === 'tool' && item.status === 'done' ? item.meta?.diffs?.map((diff) => diff.path).filter((path) => !artifactTitle(path) && (!dirty || dirty.has(path))) ?? [] : []))).size
  // Background commands and artifact files live in the main process: counted again when the chat's activity changes and when the pointer arrives.
  const [counts, setCounts] = useState({ background: 0, artifacts: 0 })
  const refresh = useCallback((): void => void window.galaxy.files.panelCounts(chat.id).then(setCounts).catch(() => {}), [chat.id])
  useEffect(refresh, [refresh, chat.status, items?.length])
  const [card, setCard] = useState<ShortcutCard | null>(null)
  const [shells, setShells] = useState<ShellRow[] | null>(null)
  const [committing, setCommitting] = useState(false)
  const [stoppingAll, setStoppingAll] = useState(false)
  // The process list refreshes while its card is open.
  useEffect(() => {
    if (card !== 'terminal') return
    // A process that has exited is not listed.
    const load = (): void => void window.galaxy.files.shells(chat.id).then((list) => setShells(list.filter((shell) => !shell.exited))).catch(() => {})
    load()
    const timer = window.setInterval(load, 1500)
    return () => window.clearInterval(timer)
  }, [card, chat.id])
  const running = (shells ?? []).filter((shell) => !shell.exited).length
  useEffect(() => { if (running === 0) setStoppingAll(false) }, [running])
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!card) return
    const away = (event: PointerEvent): void => { if (!box.current?.contains(event.target as Node)) setCard(null) }
    const key = (event: globalThis.KeyboardEvent): void => { if (event.key === 'Escape') setCard(null) }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', key)
    }
  }, [card])
  const noun = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
  const badge = (n: number): ReactNode => (n > 0 ? <span className="absolute -right-0.5 -top-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-fg px-0.5 text-[8.5px] font-semibold leading-none text-bg">{n > 99 ? '99+' : n}</span> : null)
  const toggle = (next: ShortcutCard): void => setCard((current) => (current === next ? null : next))
  return (
    <div ref={box} className="ml-auto flex shrink-0 items-center" onPointerEnter={() => { refresh(); refreshDirty() }} onFocus={() => { refresh(); refreshDirty() }}>
      {card && (
        <div className="pop-in absolute bottom-full right-0 z-30 mb-2 w-[min(460px,100%)] origin-bottom-right overflow-hidden rounded-2xl border border-line bg-elev shadow-[0_4px_16px_rgba(0,0,0,0.08)]">
          <div className="flex h-9 items-center gap-2 border-b border-line pl-3 pr-1.5">
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg">
              {card === 'diff' ? noun(changes, 'Change', 'Changes') : card === 'terminal' ? `${noun(counts.background, 'Background process', 'Background processes')} running` : `${noun(counts.artifacts, 'Artifact', 'Artifacts')} for conversation`}
            </span>
            {card === 'diff' && changes > 0 && root && (
              <Button
                size="sm"
                disabled={committing}
                onClick={() => {
                  setCommitting(true)
                  void runGitCommand('commit', chat.id, root).finally(() => { setCommitting(false); setCard(null); refreshDirty() })
                }}
              >
                {committing ? <Spinner size={12} /> : <GitCommitHorizontal size={13} />} Commit
              </Button>
            )}
            {card === 'terminal' && running > 0 && (
              <Button size="sm" disabled={stoppingAll} onClick={() => { setStoppingAll(true); void window.galaxy.files.stopShells(chat.id) }}>
                {stoppingAll ? <Spinner size={12} /> : <Square size={11} fill="currentColor" />} {stoppingAll ? 'Stopping...' : 'Stop all'}
              </Button>
            )}
          </div>
          <div className="max-h-[300px] overflow-y-auto p-1">
            {card === 'diff' ? <DiffCard root={root} items={items} dirty={dirty} /> : card === 'terminal' ? <ProcessCard chatId={chat.id} shells={shells} stoppingAll={stoppingAll} /> : <ArtifactCard chat={chat} />}
          </div>
        </div>
      )}
      <IconButton label={noun(changes, 'Change', 'Changes')} size="sm" active={card === 'diff'} onClick={() => toggle('diff')}>
        <FileDiff size={14} />
        {badge(changes)}
      </IconButton>
      <IconButton label={`${noun(counts.background, 'Background process', 'Background processes')} running`} size="sm" active={card === 'terminal'} onClick={() => toggle('terminal')}>
        <SquareTerminal size={14} />
        {badge(counts.background)}
      </IconButton>
      <IconButton label={`${noun(counts.artifacts, 'Artifact', 'Artifacts')} for conversation`} size="sm" active={card === 'files'} onClick={() => toggle('files')}>
        <File size={14} />
        {badge(counts.artifacts)}
      </IconButton>
    </div>
  )
}

/** While the agent works: the step it is on, with the whole plan on hover. */
function CurrentTask({ chat, items }: { chat: Chat; items: Item[] | undefined }): ReactNode {
  if (chat.status !== 'running' && chat.status !== 'awaiting') return null
  const list = items ?? []
  const lastUser = list.findLastIndex((item) => item.kind === 'user' && !item.parentId)
  const plan = list.slice(lastUser + 1).findLast((item): item is ToolItem => item.kind === 'tool' && !item.parentId && !!item.meta?.tasks?.length)
  const tasks = plan?.meta?.tasks ?? []
  const current = tasks.find((task) => task.status === 'in_progress') ?? tasks.find((task) => task.status === 'pending')
  if (!current) return null
  const done = tasks.filter((task) => task.status === 'completed').length
  return (
    <div className="group/task relative flex h-6 min-w-0 items-center gap-2 px-1 text-[13px] text-muted">
      <Spinner size={13} className="shrink-0" />
      <span className="shimmer min-w-0 truncate">{current.content}</span>
      <span className="shrink-0 text-[11.5px] tabular-nums text-subtle">{done}/{tasks.length}</span>
      <div className="pointer-events-none absolute bottom-full left-0 z-30 mb-1 w-full max-w-[520px] rounded-xl border border-line bg-elev p-2.5 opacity-0 shadow-pop transition-opacity group-hover/task:pointer-events-auto group-hover/task:opacity-100">
        {tasks.map((task, index) => (
          <div key={index} className="flex items-start gap-2 py-1 text-[12.5px] leading-snug" style={{ paddingLeft: (task.depth ?? 0) * 16 }}>
            <TaskMark status={task.status} size={13} className="mt-0.5" />
            <span className={cn('min-w-0', task.status === 'completed' ? 'text-subtle line-through' : task.status === 'in_progress' ? 'text-fg' : 'text-muted')}>{task.content}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

const MENU_HEADINGS: Record<MentionKind, string> = { model: 'Models', mode: 'Modes', command: 'Commands', upload: 'Attachments', skill: 'Skills', git: 'Tools', browser: 'Tools', computer: 'Tools', app: 'Apps', mcp: 'MCP servers', terminal: 'Terminals', chat: 'Recent chats', file: 'Files' }

/** Usage in one line, for what the chat runs on: a plan's limits for an account, or the OpenRouter credits for Default. */
function usageSummary(report: UsageReport, model: ResolvedModel | null, byok: boolean): string {
  const account = (SUBSCRIPTION_ACCOUNT as Record<string, string | undefined>)[model?.subscription ?? '']
  if (account === 'claude' || account === 'codex') {
    const plan = report[account]
    return plan?.windows.map((window) => `${Math.round(window.usedPercent)}% of ${window.label}`).join(' · ') || plan?.error || 'No usage to show'
  }
  if (model?.subscription !== 'Default') return 'No usage to show for this model'
  if (model.id === AUTO_MODEL.id) return 'Auto is free'
  if (byok) return 'Billed to your provider key'
  const { openrouter } = report
  if (!openrouter) return 'No OpenRouter key'
  return 'total' in openrouter ? `$${Math.max(0, openrouter.total - openrouter.used).toFixed(2)} credits left` : openrouter.error
}

const COMMAND_ICON: Record<string, typeof Globe> = { 'command:usage': Gauge, 'command:compact': FoldVertical }

const CHIP_ICON: Record<MentionKind, typeof Globe> = { model: Sparkles, mode: FileText, command: MessagesSquare, upload: Paperclip, skill: Package, file: FileText, chat: MessageCircle, browser: Globe, computer: Monitor, app: AppWindow, mcp: Plug, terminal: SquareTerminal, git: GitCommitHorizontal }

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
        const Icon = item.kind === 'git' ? GIT_COMMAND_ICON[item.command] : CHIP_ICON[item.kind]
        return (
          <span key={index} className="text-link" style={item.kind === 'git' ? { color: 'var(--orange)' } : item.kind === 'skill' && item.color ? { color: item.color } : undefined}>
            <span className="relative">
              <span className="invisible">{part[0]}</span>
              <span className="absolute left-0 top-1/2 flex -translate-y-1/2">{item.kind === 'app' && item.icon ? <img src={item.icon} alt="" width={16} height={16} className="max-w-none shrink-0" /> : item.kind === 'file' ? <FileTypeIcon name={item.name} size={11} /> : item.kind === 'skill' ? <SkillIcon icon={item.icon} color={item.color} size={13} fallback={<Icon size={13} />} /> : <Icon size={13} />}</span>
            </span>
            {part.slice(1)}
          </span>
        )
      })}
      {'\u200b'}
    </>
  )
}

type MentionKind = 'model' | 'mode' | 'command' | 'git' | 'upload' | 'skill' | 'file' | 'chat' | 'browser' | 'computer' | 'app' | 'mcp' | 'terminal'
type SelectedMention =
  | { id: string; kind: 'skill'; token: string; name: string; displayName?: string; path: string; icon?: string; color?: string }
  | { id: string; kind: 'file'; token: string; name: string; path: string }
  | { id: string; kind: 'chat'; token: string; name: string; chatId: string }
  | { id: string; kind: 'browser'; token: string }
  | { id: string; kind: 'computer'; token: string }
  | { id: string; kind: 'app'; token: string; name: string; path: string; icon?: string }
  | { id: string; kind: 'git'; token: string; command: GitCommand }
  | { id: string; kind: 'mcp'; token: string; server: string; name: string; tool?: string }
  | { id: string; kind: 'terminal'; token: string; name: string; tabId: string; cwd: string; selection?: string }
interface MentionEntry {
  id: string
  kind: MentionKind
  mode?: AgentMode
  /** Shown but not selectable; `detail` says why. */
  disabled?: boolean
  modelKey?: string
  /** An ACP session option and the value this entry sets it to. */
  acpOption?: string
  acpValue?: string
  brand?: ModelBrand
  git?: GitCommand
  name: string
  /** A skill's name for people; `name` stays the id it is sent under. */
  displayName?: string
  detail: string
  path?: string
  /** A skill's small icon. */
  icon?: string
  /** A skill's brand color. */
  color?: string
  chatId?: string
  server?: string
  tool?: string
  tabId?: string
  cwd?: string
}
