import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ACP_MODEL_ID, modelKey } from '@shared/catalog'
import { ACP_ACCOUNTS, acpAgentFor, applyCustomAcpAgents, type AccountId, type Chat, type Item, type Project, type SecretState, type Settings } from '@shared/types'
import { writeJsonAtomic } from './util'

/** Per-chat state that engines need to continue a conversation. */
export interface EngineState {
  /** OpenRouter engine: the raw message history. */
  history?: unknown[]
  claudeSessionId?: string
  codexThreadId?: string
  acpSessionId?: string
  acpAccount?: AccountId
  /** Approval keys the user allowed for the rest of the chat. */
  sessionAllow?: string[]
  /** File snapshots around each user message, by user item id. */
  checkpoints?: Record<string, { before: string; after?: string }>
  /** After a revert the agent's own session no longer matches the chat, so the next turn replays it. */
  replay?: boolean
  /** Side chats: how many of the parent chat's items the agent has already been shown. */
  parentSeen?: number
  /** Side chats: the Claude session was copied from the main chat; the first run forks it instead of continuing it. */
  forkClaude?: boolean
  /** What a revert removed, kept until the next message so it can be redone. */
  undone?: { items: Item[]; engine: Omit<EngineState, 'undone'>; files: string[]; target: string; source: string }
}

export interface ChatDoc {
  items: Item[]
  engine: EngineState
}

interface Secrets {
  openRouterKey?: string
}

const ACCOUNT_IDS: AccountId[] = ['claude', 'codex', ...ACP_ACCOUNTS]

function defaultSettings(): Settings {
  const accounts = {} as Settings['accounts']
  for (const id of ACCOUNT_IDS) accounts[id] = { enabled: true, binaryPath: '' }
  return {
    theme: 'system',
    terminalOutput: 'foreground',
    toolDensity: 'default',
    foldWork: true,
    expandToolCalls: true,
    defaultPermissionMode: 'auto',
    permissionDefaultsVersion: 1,
    defaultModelKey: null,
    disabledModels: [],
    enabledModels: [],
    customModels: [],
    imageModelKey: null,
    tabCompletion: true,
    completionModelId: null,
    inlineModelId: null,
    instantCommit: false,
    instantPush: false,
    commitMessageModelId: null,
    autoApprovalModelId: null,
    openRouterBaseUrl: 'https://openrouter.ai/api/v1',
    accounts,
    acpEnabled: true,
    customAcpAgents: [],
    mcpServers: [],
    sidebarWidth: 272,
    panelWidth: 560,
    collapsedProjects: []
  }
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

class Store {
  private dir = ''
  settings: Settings = defaultSettings()
  projects: Project[] = []
  chats = new Map<string, Chat>()
  private docs = new Map<string, ChatDoc>()
  private secrets: Secrets = {}
  private dirtyDocs = new Set<string>()
  private flushTimer: NodeJS.Timeout | null = null
  private indexTimer: NodeJS.Timeout | null = null

  init(): void {
    this.dir = app.getPath('userData')
    mkdirSync(join(this.dir, 'chats'), { recursive: true })

    const saved = readJson<Partial<Settings>>(this.file('settings.json'), {})
    const base = defaultSettings()
    this.settings = { ...base, ...saved, accounts: { ...base.accounts, ...(saved.accounts ?? {}) } }
    applyCustomAcpAgents(this.settings.customAcpAgents)
    if (!saved.permissionDefaultsVersion) {
      this.settings.defaultPermissionMode = 'auto'
      this.settings.permissionDefaultsVersion = 1
      void writeJsonAtomic(this.file('settings.json'), this.settings)
    }

    this.projects = readJson<Project[]>(this.file('projects.json'), [])
    for (const chat of readJson<Chat[]>(this.file('chats.json'), [])) {
      // Side chats do not outlive the window they were opened in.
      if (chat.side) {
        rmSync(join(this.dir, 'chats', `${chat.id}.json`), { force: true })
        continue
      }
      // A crash or quit mid-turn leaves stale activity flags behind.
      if (chat.status !== 'idle') chat.status = 'idle'
      chat.queued = []
      chat.initialSubscription ??= chat.modelKey.split(':', 1)[0]
      // ACP agents used to list fixed models; they now have one entry and pick the model in the session.
      const [subscription, modelId] = [chat.modelKey.slice(0, chat.modelKey.indexOf(':')), chat.modelKey.slice(chat.modelKey.indexOf(':') + 1)]
      if (acpAgentFor(subscription) && modelId !== ACP_MODEL_ID) chat.modelKey = modelKey(subscription, ACP_MODEL_ID)
      this.chats.set(chat.id, chat)
    }
    this.loadSecrets()
  }

  private file(name: string): string {
    return join(this.dir, name)
  }

  get dataDir(): string {
    return this.dir
  }

  // Settings

  saveSettings(patch: Partial<Settings>): Settings {
    this.settings = { ...this.settings, ...patch }
    if (patch.customAcpAgents) applyCustomAcpAgents(this.settings.customAcpAgents)
    void writeJsonAtomic(this.file('settings.json'), this.settings)
    return this.settings
  }

  // Secrets

  private loadSecrets(): void {
    const file = this.file('secrets.bin')
    if (!existsSync(file)) return
    try {
      const raw = readFileSync(file)
      const text = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8')
      this.secrets = JSON.parse(text) as Secrets
    } catch {
      this.secrets = {}
    }
  }

  private saveSecrets(): void {
    const text = JSON.stringify(this.secrets)
    const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text, 'utf8')
    writeFileSync(this.file('secrets.bin'), data, { mode: 0o600 })
  }

  get openRouterKey(): string | null {
    return this.secrets.openRouterKey?.trim() || null
  }

  setOpenRouterKey(key: string | null): void {
    if (key && key.trim()) this.secrets.openRouterKey = key.trim()
    else delete this.secrets.openRouterKey
    this.saveSecrets()
  }

  secretState(): SecretState {
    const key = this.openRouterKey
    return {
      openRouterKey: !!key,
      openRouterKeyHint: key ? `${key.slice(0, 8)}…${key.slice(-4)}` : null
    }
  }

  // Projects

  saveProjects(): void {
    void writeJsonAtomic(this.file('projects.json'), this.projects)
  }

  project(id: string | null): Project | null {
    return id ? (this.projects.find((p) => p.id === id) ?? null) : null
  }

  // Chats

  chatList(): Chat[] {
    return [...this.chats.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  saveChat(chat: Chat): void {
    this.chats.set(chat.id, chat)
    if (this.indexTimer) return
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null
      void writeJsonAtomic(this.file('chats.json'), [...this.chats.values()])
    }, 250)
  }

  doc(chatId: string): ChatDoc {
    let doc = this.docs.get(chatId)
    if (!doc) {
      doc = readJson<ChatDoc>(join(this.dir, 'chats', `${chatId}.json`), { items: [], engine: {} })
      doc.items ??= []
      doc.engine ??= {}
      // Anything still marked live belonged to a run that no longer exists.
      for (const item of doc.items) {
        if ((item.kind === 'assistant' || item.kind === 'reasoning') && item.streaming) item.streaming = false
        if (item.kind === 'tool' && (item.status === 'running' || item.status === 'pending' || item.status === 'awaiting')) {
          item.status = 'error'
          item.error = 'Interrupted'
          delete item.approval
        }
      }
      this.docs.set(chatId, doc)
    }
    return doc
  }

  touchDoc(chatId: string): void {
    this.dirtyDocs.add(chatId)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushDocs()
    }, 800)
  }

  flushDocs(): void {
    for (const id of this.dirtyDocs) {
      const doc = this.docs.get(id)
      if (doc) void writeJsonAtomic(join(this.dir, 'chats', `${id}.json`), doc)
    }
    this.dirtyDocs.clear()
  }

  /** Synchronous flush for app shutdown. */
  flushSync(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.indexTimer) clearTimeout(this.indexTimer)
    for (const id of this.dirtyDocs) {
      const doc = this.docs.get(id)
      if (doc) writeFileSync(join(this.dir, 'chats', `${id}.json`), JSON.stringify(doc))
    }
    this.dirtyDocs.clear()
    writeFileSync(this.file('chats.json'), JSON.stringify([...this.chats.values()]))
  }

  removeChat(chatId: string): void {
    this.chats.delete(chatId)
    this.docs.delete(chatId)
    this.dirtyDocs.delete(chatId)
    rmSync(join(this.dir, 'chats', `${chatId}.json`), { force: true })
    void writeJsonAtomic(this.file('chats.json'), [...this.chats.values()])
  }
}

export const store = new Store()
