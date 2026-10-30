import type { ProviderId } from './catalog'
import type {
  AccountId,
  AnalyticsRow,
  UsageReport,
  AccountStatus,
  AcpConfigOption,
  Attachment,
  Bootstrap,
  BrowserState,
  Chat,
  ChatEvent,
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
  UiEvent
} from './types'

export interface ReviewOptions {
  mode: 'uncommitted' | 'unstaged' | 'staged' | 'commit'
  commit?: string
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
    answerConsent(requestId: string, allow: boolean): Promise<void>
    /** Session options an ACP agent offers, read before a chat exists. */
    options(id: AccountId, projectId: string | null, fresh?: boolean): Promise<AcpConfigOption[]>
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
    /** /compact: summarizes the chat's history now. Galaxy models only. */
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
    reveal(path: string): Promise<void>
    openExternal(target: string): Promise<void>
    pathForFile(file: File): string
  }

  editor: {
    complete(request: { path: string; prefix: string; suffix: string }): Promise<{ text: string; offset: number; next: string | null }>
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
    stop(tabId?: string): Promise<void>
    state(tabId?: string): Promise<BrowserState>
    /** A JPEG data URL of the page as it looks now, or null before it has painted. */
    frame(tabId?: string): Promise<string | null>
  }

  terminal: {
    create(cwd: string, tabId?: string): Promise<string>
    write(tabId: string, text: string): Promise<void>
    resize(tabId: string, cols: number, rows: number): Promise<void>
    interrupt(tabId: string): Promise<void>
    close(tabId: string): Promise<void>
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
