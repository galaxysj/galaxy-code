import { AcpAgents, type AcpAgentSpec } from './acp-registry'
import type { Effort, ModelBrand, Subscription } from './models'

export type { Effort, Subscription }

export type PermissionMode = 'ask' | 'auto' | 'accept-edits' | 'full'
/** Read-only modes for a single message. Without one the agent works normally. */
export type AgentMode = 'ask' | 'plan'
export type WorkspaceMode = 'local' | 'worktree'
export type ThemeMode = 'system' | 'light' | 'dark'

/** How terminal commands show their output in the timeline. */
export type TerminalOutputMode = 'collapsed' | 'foreground' | 'preview'

/** Compact folds every run of tool calls into one summary line. */
export type ToolDensity = 'default' | 'medium' | 'compact'
export type ChatStatus = 'idle' | 'running' | 'awaiting' | 'error'

/** A model as the UI and engines see it: built-in or user-defined, flattened. */
export interface ResolvedModel {
  brand?: ModelBrand
  /** Stable key: `${subscription}:${id}`. */
  key: string
  name: string
  id: string
  subscription: Subscription
  efforts: Effort[]
  defaultEffort: Effort | null
  ultraEffort: Effort | null
  fastMode: boolean
  /** Offers Ultrafast above Fast. Only true when fastMode is. */
  ultrafastMode: boolean
  vision: boolean
  custom: boolean
  enabled: boolean
  /** Ships switched off; turning it on records it in enabledModels. */
  defaultOff?: boolean
  /** OpenRouter's router, which picks a model per request. Offered apart from the list. */
  auto?: boolean
}

export interface ResolvedImageModel {
  key: string
  name: string
  id: string
  subscription: Subscription
}

export interface CustomModel {
  name: string
  id: string
  subscription: Subscription
}

export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface McpToolInfo {
  name: string
  description: string
}

export interface McpServerStatus {
  id: string
  state: 'disabled' | 'connecting' | 'ready' | 'error'
  error?: string
  tools: McpToolInfo[]
}

/** 'claude', 'codex', or an ACP agent's ID from acp-registry.ts. */
export type AccountId = 'claude' | 'codex' | (string & {})

/** An ACP agent added in Settings: any command that speaks the Agent Client Protocol on stdio. */
export interface CustomAcpAgent {
  id: string
  /** Shown in Settings and the subscription picker. Also keys saved chats. */
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}

/** One model's token and cost totals for one local day. */
export interface AnalyticsRow {
  day: string
  modelKey: string
  name: string
  subscription: string
  input: number
  output: number
  cost: number
  calls: number
}

export interface AccountSettings {
  enabled: boolean
  /** Overrides binary lookup on PATH. */
  binaryPath: string
}

export interface AcpConfigChoice {
  value: string
  name: string
  description?: string
  /** Set when the agent groups its choices, for example by provider. */
  group?: string
}

/** A session config option an ACP agent reports: model, mode, thought level, or its own. */
export interface AcpConfigOption {
  id: string
  name: string
  description?: string
  /** 'model', 'mode', 'thought_level', or null for agent-specific options. */
  category: string | null
  currentValue: string
  options: AcpConfigChoice[]
}

export interface AccountStatus {
  id: AccountId
  installed: boolean
  binary: string | null
  version: string | null
  /** null when the CLI offers no way to check. */
  authenticated: boolean | null
  detail: string | null
}

export interface Settings {
  theme: ThemeMode
  terminalOutput: TerminalOutputMode
  toolDensity: ToolDensity
  /** Fold a finished turn's work under "Worked for" above its final response. */
  foldWork: boolean
  /** Open tool groups while they run. Off keeps them as one summary line until clicked. */
  expandToolCalls: boolean
  defaultPermissionMode: PermissionMode
  /** One-time migration to the Auto permission default. */
  permissionDefaultsVersion?: number
  defaultModelKey: string | null
  disabledModels: string[]
  /** Models shipped with Off: true that the user turned on. */
  enabledModels: string[]
  customModels: CustomModel[]
  imageModelKey: string | null
  /** Ghost-text suggestions in the file editor, accepted with Tab. */
  tabCompletion: boolean
  /** ID from CompletionModel in models.ts. */
  completionModelId: string | null
  /** ID from InlineModel in models.ts, the last one picked in the Ctrl+I box. */
  inlineModelId: string | null
  /** Commit buttons commit at once with a generated message instead of asking the agent. */
  instantCommit: boolean
  /** The Push button pushes at once instead of asking the agent. */
  instantPush: boolean
  /** ID from CommitMessageModel in models.ts. */
  commitMessageModelId: string | null
  /** ID from AutoApprovalModel in models.ts. */
  autoApprovalModelId: string | null
  openRouterBaseUrl: string
  accounts: Record<AccountId, AccountSettings>
  /** Master switch for the agents reached over the Agent Client Protocol. */
  acpEnabled: boolean
  /** ACP agents the user added in Settings, on top of acp-registry.ts. */
  customAcpAgents: CustomAcpAgent[]
  mcpServers: McpServerConfig[]
  sidebarWidth: number
  panelWidth: number
  collapsedProjects: string[]
}

/** Never leaves the main process. The renderer only learns whether a key exists. */
export interface SecretState {
  openRouterKey: boolean
  openRouterKeyHint: string | null
}

export interface Project {
  id: string
  name: string
  path: string
  createdAt: number
  isGit: boolean
}

export interface WorktreeInfo {
  path: string
  branch: string
  baseBranch: string | null
}

export interface ChatUsage {
  inputTokens: number
  outputTokens: number
  cost: number
  /** Prompt size of the latest request, a rough context gauge. */
  contextTokens: number
}

export interface Chat {
  /** While the chat listens for Event triggers: what it will resume after. */
  resumeAfter?: string | null
  /** Immutable subscription chosen when this chat was created. */
  initialSubscription?: Subscription
  id: string
  projectId: string | null
  title: string
  createdAt: number
  updatedAt: number
  status: ChatStatus
  unread: boolean
  modelKey: string
  effort: Effort | null
  ultra: boolean
  fast: boolean
  /** With fast on, runs at the Ultrafast tier instead. */
  ultrafast?: boolean
  permissionMode: PermissionMode
  workspace: WorkspaceMode
  worktree: WorktreeInfo | null
  usage: ChatUsage
  queued: QueuedMessage[]
  /** ACP chats: values the user picked, by config option id. */
  acpConfig?: Record<string, string>
  /** ACP chats: the options the agent last reported for this chat's session. */
  acpOptions?: AcpConfigOption[]
  /** Set after a revert until the next message: the reverted message, offered for editing and redo. */
  reverted?: RevertedMessage | null
  /** A side chat lives in a panel tab, stays out of the chat list, and is deleted when closed or on restart. */
  side?: boolean
  /** Side chats: the chat they were opened from, whose conversation they can see. */
  parentChatId?: string
  /** Number of inherited timeline items before this side chat's own messages. */
  sideContextItemCount?: number
}

export interface UsageWindow {
  label: string
  /** 0-100 */
  usedPercent: number
  resetsAt: string | null
}

export interface PlanUsage {
  plan?: string | null
  windows: UsageWindow[]
  error?: string
}

/** null for a provider that is off or has no key. */
export interface UsageReport {
  openrouter: { total: number; used: number; keyLimit: number | null; keyRemaining: number | null } | { error: string } | null
  claude: PlanUsage | null
  codex: PlanUsage | null
}

export interface RevertedMessage {
  text: string
  attachments: Attachment[]
  mentions?: PromptMentions
}

export interface Attachment {
  id: string
  name: string
  path: string
  mime: string
  size: number
  /** Data URL thumbnail for images. */
  preview?: string
}

export interface QueuedMessage {
  steer?: boolean
  id: string
  text: string
  attachments: Attachment[]
  mentions?: PromptMentions
  mode?: AgentMode
  plan?: string
}

export interface PromptMentions {
  skills: { name: string; path: string }[]
  files: { name: string; path: string }[]
  chats: { title: string; excerpt: string }[]
  browser: boolean
  tools: { server: string; name: string }[]
  /** Terminal tabs, or text selected in one, as they were when the message was sent. */
  terminals?: { name: string; tabId: string; cwd: string; text: string; selection: boolean }[]
  /** Set by @Commit, @Commit & Push or @Push: commit the working tree, push after it, or only push. */
  git?: GitCommand
  /** Where each pick sits in the text, so the message can show it as a chip. */
  chips?: MentionChip[]
}

export type GitCommand = 'commit' | 'commit-push' | 'push'

export interface MentionChip {
  token: string
  kind: 'skill' | 'file' | 'chat' | 'browser' | 'mcp' | 'terminal' | 'git'
  label: string
  /** Hover text, such as a file's full path. */
  title?: string
}

export type ToolKind =
  | 'read'
  | 'grep'
  | 'glob'
  | 'list'
  | 'lint'
  | 'wait'
  | 'event'
  | 'websearch'
  | 'webfetch'
  | 'bash'
  | 'edit'
  | 'create'
  | 'browser'
  | 'mcp'
  | 'agent'
  | 'ask'
  | 'task'
  | 'present'
  | 'open'
  | 'memory'
  | 'image'
  | 'other'

export const EXPLORE_KINDS: ToolKind[] = ['read', 'grep', 'glob', 'list', 'lint', 'wait', 'websearch', 'webfetch']

export type ToolStatus = 'pending' | 'awaiting' | 'running' | 'done' | 'error' | 'denied'

export interface AskOption {
  label: string
  description?: string
}

export interface AskQuestion {
  header?: string
  question: string
  options: AskOption[]
  multiSelect?: boolean
}

export interface TaskEntry {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface FileDiff {
  path: string
  added: number
  removed: number
  /** Unified diff body, hunks only. */
  patch: string
  created?: boolean
  deleted?: boolean
}

export interface PresentedFile {
  path: string
  name: string
  mime: string
  size: number
}

export interface ApprovalRequest {
  id: string
  /** 'ask': mode requires approval. 'auto': the approval model declined. */
  source: 'ask' | 'auto'
  reason?: string
  /** Lets the user approve the same kind of action for the rest of the chat. */
  sessionKey?: string
  sessionLabel?: string
}

export interface ToolMeta {
  recipientName?: string
  diffs?: FileDiff[]
  exitCode?: number | null
  command?: string
  cwd?: string
  background?: boolean
  /** Where a background command writes its output. */
  log?: string
  skill?: string
  url?: string
  query?: string
  results?: { title: string; url: string; snippet?: string }[]
  questions?: AskQuestion[]
  answers?: Record<string, string>
  tasks?: TaskEntry[]
  files?: PresentedFile[]
  summary?: string
  images?: string[]
  server?: string
  agentType?: string
  matches?: number
  lines?: number
  autoApproved?: boolean
  autoReason?: string
}

interface ItemBase {
  id: string
  ts: number
  /** Id of the Agent tool item this belongs to, for subagent activity. */
  parentId?: string
}

export interface UserItem extends ItemBase {
  kind: 'user'
  text: string
  /** Set when an Event resumed the agent: the event's label. Not shown in the timeline. */
  event?: string
  attachments: Attachment[]
  mentions?: MentionChip[]
  /** Full mentions as sent, so a reverted message can be edited and sent again. */
  prompt?: PromptMentions
  /** A file checkpoint was taken before this message, so it can be reverted. */
  revertible?: boolean
  mode?: AgentMode
  /** Set when the message was sent by Build: the plan file it carries out. Shown as a card instead of the text. */
  plan?: string
}

export interface AssistantItem extends ItemBase {
  kind: 'assistant'
  text: string
  streaming?: boolean
}

export interface ReasoningItem extends ItemBase {
  kind: 'reasoning'
  text: string
  streaming?: boolean
  endedAt?: number
}

export interface ToolItem extends ItemBase {
  kind: 'tool'
  tool: ToolKind
  /** Raw tool name as the model called it. */
  name: string
  title: string
  detail?: string
  input: unknown
  status: ToolStatus
  output?: string
  error?: string
  endedAt?: number
  meta?: ToolMeta
  approval?: ApprovalRequest
}

export interface NoticeItem extends ItemBase {
  kind: 'notice'
  level: 'info' | 'error'
  text: string
}

export interface TurnItem extends ItemBase {
  kind: 'turn'
  durationMs: number
  interrupted?: boolean
}

export type Item = UserItem | AssistantItem | ReasoningItem | ToolItem | NoticeItem | TurnItem

export type ChatEvent =
  | { type: 'chat'; chat: Chat }
  | { type: 'chat-removed'; chatId: string }
  | { type: 'item'; chatId: string; item: Item }
  | { type: 'delta'; chatId: string; itemId: string; field: 'text' | 'output'; delta: string; offset: number }
  | { type: 'items-reset'; chatId: string; items: Item[] }

export type UiEvent =
  | { type: 'antigravity-consent'; requestId: string }
  | { type: 'open-file'; chatId: string; path: string; line?: number }
  | { type: 'open-browser'; chatId: string; tabId?: string; background?: boolean }
  | { type: 'open-browser-tab'; tabId: string; background?: boolean }
  | { type: 'open-panel'; chatId: string; pane: 'terminal' | 'review'; cwd: string; tabId?: string }
  | { type: 'terminal-output'; tabId: string; text: string; exited?: boolean }
  | { type: 'close-panel-tab'; tabId: string }
  | { type: 'inline-edit-delta'; requestId: string; text: string }
  | { type: 'settings'; settings: Settings; secrets: SecretState }
  | { type: 'projects'; projects: Project[] }
  | { type: 'mcp-status'; statuses: McpServerStatus[] }
  | { type: 'browser-state'; state: BrowserState; tabId?: string }
  | { type: 'menu'; action: 'new-chat' | 'settings' | 'toggle-sidebar' | 'toggle-panel' | 'open-files' | 'open-browser' | 'open-terminal' }

export interface BrowserState {
  favicon?: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** True while the agent is driving the page. */
  agentActive: boolean
}

export interface ProjectFileEntry {
  name: string
  path: string
  relativePath: string
  directory: boolean
}

export interface NewChatInput {
  projectId: string | null
  modelKey: string
  effort: Effort | null
  ultra: boolean
  fast: boolean
  ultrafast?: boolean
  permissionMode: PermissionMode
  workspace: WorkspaceMode
  acpConfig?: Record<string, string>
  side?: boolean
  parentChatId?: string
}

export interface SendInput {
  steer?: boolean
  chatId: string
  text: string
  attachments: Attachment[]
  mentions?: PromptMentions
  mode?: AgentMode
  plan?: string
}

export interface CreateProjectInput {
  name?: string
  path?: string
}

export interface FileView {
  path: string
  name: string
  mime: string
  size: number
  kind: 'text' | 'image' | 'binary' | 'missing'
  content?: string
  dataUrl?: string
  truncated?: boolean
}

export interface SkillInfo {
  name: string
  description: string
  path: string
  scope: 'user' | 'project'
}

export interface GitInfo {
  isRepo: boolean
  branch: string | null
}

export interface Bootstrap {
  settings: Settings
  secrets: SecretState
  projects: Project[]
  chats: Chat[]
  models: ResolvedModel[]
  imageModels: ResolvedImageModel[]
  mcp: McpServerStatus[]
  platform: string
  homeDir: string
  version: string
}

export const ACCOUNT_LABELS: Record<AccountId, string> = { claude: 'Claude Code', codex: 'Codex' }

/** Accounts that run over the Agent Client Protocol, as opposed to Claude Code and Codex. */
export const ACP_ACCOUNTS: AccountId[] = []

/** Accounts whose own free models still work when not signed in. */
export const KEYLESS_ACCOUNTS: AccountId[] = []

export const SUBSCRIPTION_ACCOUNT: Record<Exclude<Subscription, 'Default'>, AccountId> = { Claude: 'claude', Codex: 'codex' }

export const SUBSCRIPTIONS: Subscription[] = []

const BUILTIN_ACP = AcpAgents.length
const RESERVED_NAMES = new Set(['default', 'local', 'openrouter', 'claude', 'claude code', 'codex'])

/** The registry entry for an ACP agent added in Settings. */
function customAcpSpec(agent: CustomAcpAgent): AcpAgentSpec {
  return {
    ID: agent.id,
    DisplayName: agent.name,
    Description: 'Custom agent.',
    Binaries: [agent.command],
    Args: agent.args,
    Env: agent.env,
    // There is no generic way to ask an arbitrary agent whether it is signed in, so an installed one counts as usable.
    Keyless: true,
    Custom: true
  }
}

/**
 * Puts the user's own ACP agents into the registry and the account tables built from it.
 * The tables are filled in place, so every module that imported them sees the change.
 * Main and renderer call this whenever settings load or change.
 */
export function applyCustomAcpAgents(custom: CustomAcpAgent[] | undefined): void {
  const names = new Set([...RESERVED_NAMES, ...AcpAgents.slice(0, BUILTIN_ACP).map((agent) => agent.DisplayName.toLowerCase())])
  const ids = new Set(AcpAgents.slice(0, BUILTIN_ACP).map((agent) => agent.ID))
  const added = (custom ?? []).filter((agent) => {
    const name = agent.name.trim().toLowerCase()
    if (!name || !agent.command.trim() || names.has(name) || ids.has(agent.id)) return false
    names.add(name)
    ids.add(agent.id)
    return true
  })
  AcpAgents.splice(BUILTIN_ACP, AcpAgents.length - BUILTIN_ACP, ...added.map(customAcpSpec))

  for (const key of Object.keys(ACCOUNT_LABELS)) delete ACCOUNT_LABELS[key]
  Object.assign(ACCOUNT_LABELS, { claude: 'Claude Code', codex: 'Codex' }, Object.fromEntries(AcpAgents.map((agent) => [agent.ID, agent.DisplayName])))
  ACP_ACCOUNTS.splice(0, ACP_ACCOUNTS.length, ...AcpAgents.map((agent) => agent.ID))
  KEYLESS_ACCOUNTS.splice(0, KEYLESS_ACCOUNTS.length, ...AcpAgents.filter((agent) => agent.Keyless).map((agent) => agent.ID))
  for (const key of Object.keys(SUBSCRIPTION_ACCOUNT)) delete SUBSCRIPTION_ACCOUNT[key]
  Object.assign(SUBSCRIPTION_ACCOUNT, { Claude: 'claude', Codex: 'codex' }, Object.fromEntries(AcpAgents.map((agent) => [agent.DisplayName, agent.ID])))
  SUBSCRIPTIONS.splice(0, SUBSCRIPTIONS.length, 'Default', 'Claude', 'Codex', ...AcpAgents.map((agent) => agent.DisplayName))
}

applyCustomAcpAgents([])

/** The subscription an account serves, the inverse of SUBSCRIPTION_ACCOUNT. */
export function accountSubscription(id: AccountId): Subscription | null {
  return SUBSCRIPTIONS.find((sub) => sub !== 'Default' && SUBSCRIPTION_ACCOUNT[sub] === id) ?? null
}

/** The ACP agent that serves a subscription, if any. */
export function acpAgentFor(subscription: Subscription | null | undefined): string | null {
  if (!subscription || subscription === 'Default') return null
  const id = SUBSCRIPTION_ACCOUNT[subscription]
  return id && ACP_ACCOUNTS.includes(id) ? id : null
}

export const EFFORT_LABELS: Record<Effort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}
