import type {
  AccountId,
  AccountStatus,
  AcpConfigOption,
  Attachment,
  Bootstrap,
  BrowserState,
  Chat,
  ChatEvent,
  CreateProjectInput,
  FileView,
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
    signInOpenRouter(): Promise<{ ok: boolean; message: string }>
  }

  accounts: {
    status(): Promise<AccountStatus[]>
    login(id: AccountId): Promise<{ ok: boolean; message: string }>
  }

  acp: {
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
      patch: Partial<Pick<Chat, 'modelKey' | 'effort' | 'ultra' | 'fast' | 'permissionMode' | 'title' | 'acpConfig'>>
    ): Promise<Chat>
    remove(chatId: string): Promise<void>
    markRead(chatId: string): Promise<void>
    approve(chatId: string, approvalId: string, decision: 'allow' | 'allow-session' | 'deny', note?: string): Promise<void>
    answer(chatId: string, itemId: string, answers: Record<string, string> | null): Promise<void>
    unqueue(chatId: string, messageId: string): Promise<void>
  }

  files: {
    listProject(projectId: string, relativePath: string, chatId?: string): Promise<ProjectFileEntry[]>
    searchProject(projectId: string, query: string, chatId?: string): Promise<ProjectFileEntry[]>
    pickAttachments(): Promise<Attachment[]>
    attachFromPaths(paths: string[]): Promise<Attachment[]>
    attachFromData(name: string, mime: string, base64: string): Promise<Attachment>
    read(path: string, chatId?: string): Promise<FileView>
    reveal(path: string): Promise<void>
    openExternal(target: string): Promise<void>
    pathForFile(file: File): string
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
  }

  terminal: {
    create(cwd: string, tabId?: string): Promise<string>
    write(tabId: string, text: string): Promise<void>
    resize(tabId: string, cols: number, rows: number): Promise<void>
    interrupt(tabId: string): Promise<void>
    close(tabId: string): Promise<void>
  }
  review: { read(cwd: string): Promise<{ isRepo: boolean; patch: string; untracked: string[] }> }

  onChatEvent(listener: (event: ChatEvent) => void): () => void
  onUiEvent(listener: (event: UiEvent) => void): () => void
}

export const IPC_INVOKE = 'galaxy:invoke'
export const IPC_CHAT_EVENT = 'galaxy:chat-event'
export const IPC_UI_EVENT = 'galaxy:ui-event'
