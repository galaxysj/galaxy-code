import type { ProviderId } from './catalog'
import type {
  AccountId,
  AnalyticsRow,
  UsageReport,
  AccountStatus,
  AcpAgentConfig,
  AcpConfigOption,
  AcpRegistryAgent,
  Attachment,
  Bootstrap,
  BrowserDataKind,
  BrowserPick,
  BrowserState,
  Chat,
  ChatEvent,
  ComputerPermission,
  ComputerPermissions,
  InstalledApp,
  CreateProjectInput,
  FileView,
  FileDiff,
  GitInfo,
  Item,
  NewChatInput,
  Project,
  ProjectFileEntry,
  SendInput,
  Settings,
  SkillInfo,
  UiEvent,
  WorktreeMergeResult,
  WorktreeMergeStrategy,
  WorktreeStatus
} from './types'

export interface ReviewOptions {
  mode: 'uncommitted' | 'unstaged' | 'staged' | 'commit' | 'branch'
  commit?: string
  /** branch mode: the branch to compare with. */
  base?: string
}

export interface ReviewCommit {
  hash: string
  shortHash: string
  subject: string
  author: string
  date: string
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Everything the renderer can ask the main process to do. */
export interface GalaxyApi {
  bootstrap(): Promise<Bootstrap>

  windows: {
    create(): Promise<void>
    ready(): Promise<void>
  }

  settings: {
    update(patch: Partial<Settings>): Promise<Settings>
    setOpenRouterKey(key: string | null): Promise<void>
    testOpenRouterKey(): Promise<{ ok: boolean; message: string }>
    setProviderKey(id: ProviderId, key: string | null): Promise<void>
    testProviderKey(id: ProviderId): Promise<{ ok: boolean; message: string }>
    /** Whether OpenRouter has nothing left to spend, so only Auto and models paid elsewhere can run. */
    creditsLocked(): Promise<boolean>
    /** OpenRouter credits and Claude / Codex plan limits. */
    usage(): Promise<UsageReport>
    analytics(): Promise<AnalyticsRow[]>
    signInOpenRouter(): Promise<{ ok: boolean; message: string }>
  }

  accounts: {
    status(): Promise<AccountStatus[]>
    login(id: AccountId): Promise<{ ok: boolean; message: string }>
  }

  acp: {
    /** Session options an ACP agent offers, read before a chat exists. A failure is returned, with signIn when the agent needs a sign-in. */
    options(id: AccountId, projectId: string | null, fresh?: boolean): Promise<{ options: AcpConfigOption[]; error?: string; signIn?: boolean }>
    /** Agents in the public ACP registry that run on this computer. */
    registry(fresh?: boolean): Promise<AcpRegistryAgent[]>
    /** Downloads a registry agent when it ships as a binary, and returns its Settings entry. */
    install(id: string): Promise<AcpAgentConfig>
  }

  projects: {
    create(input: CreateProjectInput): Promise<Project>
    rename(id: string, name: string): Promise<void>
    remove(id: string): Promise<void>
    pickFolder(): Promise<string | null>
    git(id: string): Promise<GitInfo>
    reveal(id: string): Promise<void>
  }

  chats: {
    create(input: NewChatInput): Promise<Chat>
    items(chatId: string): Promise<Item[]>
    send(input: SendInput): Promise<void>
    stop(chatId: string): Promise<void>
    update(
      chatId: string,
      patch: Partial<Pick<Chat, 'modelKey' | 'effort' | 'ultra' | 'fast' | 'ultrafast' | 'permissionMode' | 'title' | 'acpConfig'>>
    ): Promise<Chat>
    remove(chatId: string): Promise<void>
    markRead(chatId: string): Promise<void>
    approve(chatId: string, approvalId: string, decision: 'allow' | 'allow-session' | 'deny', note?: string): Promise<void>
    answer(chatId: string, itemId: string, answers: Record<string, string> | null): Promise<void>
    unqueue(chatId: string, messageId: string): Promise<void>
    /** Puts files and the timeline back to before a user message. Rejects on conflicts. */
    /** `messageOnly` takes the turns out of the timeline and leaves the files as they are. Resolves with why the files could not be restored, or null. */
    revert(chatId: string, itemId: string, messageOnly?: boolean): Promise<string | null>
    /** Undoes the last revert. */
    redo(chatId: string): Promise<void>
    /** /compact: summarizes the chat's history now. Galaxy models and Codex only. */
    compact(chatId: string): Promise<void>
  }

  files: {
    listProject(projectId: string, relativePath: string, chatId?: string): Promise<ProjectFileEntry[]>
    searchProject(projectId: string, query: string, chatId?: string): Promise<ProjectFileEntry[]>
    /** Creates an empty file or a folder inside `parent`, a path relative to the project. */
    createEntry(projectId: string, parent: string, name: string, directory: boolean, chatId?: string): Promise<ProjectFileEntry>
    renameEntry(projectId: string, relativePath: string, name: string, chatId?: string): Promise<ProjectFileEntry>
    /** Moves the entry to the system Trash. */
    trashEntry(projectId: string, relativePath: string, chatId?: string): Promise<void>
    /** Copies entries into `parent`, adding " copy" to names that are taken. */
    copyEntries(projectId: string, relativePaths: string[], parent: string, chatId?: string): Promise<ProjectFileEntry[]>
    pickAttachments(): Promise<Attachment[]>
    attachFromPaths(paths: string[]): Promise<Attachment[]>
    attachFromData(name: string, mime: string, base64: string): Promise<Attachment>
    read(path: string, chatId?: string): Promise<FileView>
    write(path: string, content: string): Promise<void>
    /** Counts behind the shortcut icons above the input: the chat's running background commands and its artifact files. */
    panelCounts(chatId: string): Promise<{ background: number; artifacts: number }>
    /** The chat's background commands and the log file each writes to. */
    shells(chatId: string): Promise<{ id: string; name: string; log: string; exited: boolean; code: number | null }[]>
    /** Stops one background command of the chat, or every one when no id is given. */
    stopShells(chatId: string, id?: string): Promise<void>
    /** Every file in the chat's artifacts folder, newest first, with the name from a document's front matter when it has one. */
    artifacts(chatId: string): Promise<{ path: string; title: string | null }[]>
    reveal(path: string): Promise<void>
    /** Asks where to save, then copies the file there. Returns the new path, or null when cancelled. */
    saveCopy(path: string, name: string): Promise<string | null>
    openExternal(target: string): Promise<void>
    pathForFile(file: File): string
  }

  editor: {
    complete(request: { path: string; prefix: string; suffix: string; related?: string; edits?: string }): Promise<{ text: string; offset: number; next: string | null }>
    suggestEdit(request: { path: string; text: string; offset: number; related?: string; edits?: string }): Promise<{ startLine: number; endLine: number; text: string } | null>
    inlineEdit(request: { path: string; before: string; selection: string; after: string; instruction: string; modelId: string; requestId: string }): Promise<string>
    cancelInlineEdit(requestId: string): Promise<void>
    terminalCommand(request: { instruction: string; cwd: string; output: string; modelId: string; requestId: string }): Promise<string>
  }

  skills: {
    list(projectId: string | null): Promise<SkillInfo[]>
    openFolder(scope: 'user' | 'project', projectId: string | null): Promise<void>
  }

  mcp: {
    reconnect(id: string): Promise<void>
  }

  browser: {
    create(): Promise<string>
    setTabOrder(tabIds: string[], titles?: Record<string, string>): Promise<void>
    close(tabId: string): Promise<void>
    setBounds(rect: Rect | null, tabId?: string): Promise<void>
    navigate(url: string, tabId?: string): Promise<void>
    back(tabId?: string): Promise<void>
    forward(tabId?: string): Promise<void>
    reload(tabId?: string): Promise<void>
    /** Lays the page out at this size; null for both goes back to the panel's size. */
    resize(width: number | null, height: number | null, tabId?: string): Promise<void>
    /** Opens Chrome DevTools for the tab in device mode, or toggles device mode when it is open. */
    deviceMode(tabId?: string): Promise<void>
    stop(tabId?: string): Promise<void>
    state(tabId?: string): Promise<BrowserState>
    /** A JPEG data URL of the page as it looks now, or null before it has painted. */
    frame(tabId?: string): Promise<string | null>
    clearData(kind: BrowserDataKind): Promise<void>
    /** Comment mode: waits while the user clicks an element or drags a rectangle on the page. Null when cancelled. */
    pick(tabId?: string): Promise<BrowserPick | null>
    cancelPick(tabId?: string): Promise<void>
  }

  computer: {
    permissions(): Promise<ComputerPermissions>
    /** Registers the app with macOS and opens the matching Privacy & Security list. */
    requestPermission(kind: ComputerPermission): Promise<void>
    /** Finds installed desktop apps by name, for @ mentions. */
    searchApps(query: string): Promise<InstalledApp[]>
    /** Streams exactly these windows an agent has worked in as computer-frame events. */
    watch(windowIds: number[]): Promise<void>
  }

  terminal: {
    create(cwd: string, tabId?: string): Promise<string>
    write(tabId: string, text: string): Promise<void>
    resize(tabId: string, cols: number, rows: number): Promise<void>
    interrupt(tabId: string): Promise<void>
    close(tabId: string): Promise<void>
  }
  worktree: {
    /** null for a chat with no worktree. */
    status(chatId: string): Promise<WorktreeStatus | null>
    merge(chatId: string, strategy: WorktreeMergeStrategy): Promise<WorktreeMergeResult>
    /** Brings the base branch's new commits into the worktree. */
    update(chatId: string): Promise<WorktreeMergeResult>
  }
  review: {
    status(cwd: string): Promise<{ isRepo: boolean }>
    init(cwd: string): Promise<void>
    read(cwd: string, options?: ReviewOptions): Promise<{ isRepo: boolean; diffs: FileDiff[] }>
    commits(cwd: string): Promise<ReviewCommit[]>
    push(cwd: string): Promise<{ branch: string; remote: string }>
    state(cwd: string): Promise<{ isRepo: boolean; dirty: boolean; hasRemote: boolean }>
    /** Stages everything, commits with a generated message, and pushes when asked. */
    instantCommit(cwd: string, push: boolean): Promise<{ hash: string; message: string; pushed: { branch: string; remote: string } | null }>
  }

  onChatEvent(listener: (event: ChatEvent) => void): () => void
  onUiEvent(listener: (event: UiEvent) => void): () => void
}

export const IPC_INVOKE = 'galaxy:invoke'
export const IPC_CHAT_EVENT = 'galaxy:chat-event'
export const IPC_UI_EVENT = 'galaxy:ui-event'
