import { AcpAgents } from './acp-registry'
import type { Effort, Subscription } from './models'

export type { Effort, Subscription }

export type PermissionMode = 'ask' | 'auto' | 'full'
export type WorkspaceMode = 'local' | 'worktree'
export type ThemeMode = 'system' | 'light' | 'dark'
export type ChatStatus = 'idle' | 'running' | 'awaiting' | 'error'

/** A model as the UI and engines see it: built-in or user-defined, flattened. */
export interface ResolvedModel {
  /** Stable key: `${subscription}:${id}`. */
  key: string
  name: string
  id: string
  subscription: Subscription
  efforts: Effort[]
  defaultEffort: Effort | null
  ultraEffort: Effort | null
  fastMode: boolean
  vision: boolean
  custom: boolean
  enabled: boolean
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
  defaultPermissionMode: PermissionMode
  /** One-time migration to the Auto permission default. */
  permissionDefaultsVersion?: number
  defaultModelKey: string | null
  disabledModels: string[]
  customModels: CustomModel[]
  imageModelKey: string | null
  openRouterBaseUrl: string
  accounts: Record<AccountId, AccountSettings>
  /** Master switch for the agents reached over the Agent Client Protocol. */
  acpEnabled: boolean
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
  permissionMode: PermissionMode
  workspace: WorkspaceMode
  worktree: WorktreeInfo | null
  usage: ChatUsage
  queued: QueuedMessage[]
  /** ACP chats: values the user picked, by config option id. */
  acpConfig?: Record<string, string>
  /** ACP chats: the options the agent last reported for this chat's session. */
  acpOptions?: AcpConfigOption[]
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
  id: string
  text: string
  attachments: Attachment[]
  mentions?: PromptMentions
}

export interface PromptMentions {
  skills: { name: string; path: string }[]
  files: { name: string; path: string }[]
  chats: { title: string; excerpt: string }[]
  browser: boolean
  tools: { server: string; name: string }[]
}

export type ToolKind =
  | 'read'
  | 'grep'
  | 'glob'
  | 'list'
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

export const EXPLORE_KINDS: ToolKind[] = ['read', 'grep', 'glob', 'list', 'websearch', 'webfetch']

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
  attachments: Attachment[]
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
  | { type: 'open-file'; chatId: string; path: string; line?: number }
  | { type: 'open-browser'; chatId: string; tabId?: string; background?: boolean }
  | { type: 'open-browser-tab'; tabId: string; background?: boolean }
  | { type: 'open-panel'; chatId: string; pane: 'terminal' | 'review'; cwd: string; tabId?: string }
  | { type: 'terminal-output'; tabId: string; text: string; exited?: boolean }
  | { type: 'close-panel-tab'; tabId: string }
  | { type: 'settings'; settings: Settings; secrets: SecretState }
  | { type: 'projects'; projects: Project[] }
  | { type: 'mcp-status'; statuses: McpServerStatus[] }
  | { type: 'browser-state'; state: BrowserState; tabId?: string }
  | { type: 'menu'; action: 'new-chat' | 'settings' | 'toggle-sidebar' | 'toggle-panel' }

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
  permissionMode: PermissionMode
  workspace: WorkspaceMode
  acpConfig?: Record<string, string>
}

export interface SendInput {
  chatId: string
  text: string
  attachments: Attachment[]
  mentions?: PromptMentions
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
  autoApprovalModel: { name: string; id: string }
  mcp: McpServerStatus[]
  platform: string
  homeDir: string
  version: string
}

export const ACCOUNT_LABELS: Record<AccountId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  ...Object.fromEntries(AcpAgents.map((agent) => [agent.ID, agent.DisplayName]))
}

/** Accounts that run over the Agent Client Protocol, as opposed to Claude Code and Codex. */
export const ACP_ACCOUNTS: AccountId[] = AcpAgents.map((agent) => agent.ID)

/** Accounts whose own free models still work when not signed in. */
export const KEYLESS_ACCOUNTS: AccountId[] = AcpAgents.filter((agent) => agent.Keyless).map((agent) => agent.ID)

export const SUBSCRIPTION_ACCOUNT: Record<Exclude<Subscription, 'Default'>, AccountId> = {
  Claude: 'claude',
  Codex: 'codex',
  ...Object.fromEntries(AcpAgents.map((agent) => [agent.DisplayName, agent.ID]))
}

export const SUBSCRIPTIONS: Subscription[] = ['Default', 'Claude', 'Codex', ...AcpAgents.map((agent) => agent.DisplayName)]

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
