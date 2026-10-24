import { create } from 'zustand'
import { availableSubscriptions, defaultModel, findModel, normalizeEffort, resolveImageModels, resolveModels } from '@shared/catalog'
import {
  acpAgentFor,
  type AccountStatus,
  type AcpConfigOption,
  type Attachment,
  type BrowserState,
  type Chat,
  type ChatEvent,
  type Effort,
  type Item,
  type McpServerStatus,
  type PromptMentions,
  type PermissionMode,
  type Project,
  type ResolvedImageModel,
  type ResolvedModel,
  type SecretState,
  type Settings,
  type Subscription,
  type UiEvent,
  type WorkspaceMode
} from '@shared/types'

export type SettingsSection = 'general' | 'models' | 'providers' | 'accounts' | 'acp' | 'mcp' | 'skills'

export interface Draft {
  projectId: string | null
  workspace: WorkspaceMode
  modelKey: string
  effort: Effort | null
  ultra: boolean
  fast: boolean
  permissionMode: PermissionMode
  /** Values picked for an ACP agent's session options, by option id. */
  acpConfig?: Record<string, string>
}

/** Session options an ACP agent reported before a chat exists. */
export interface AcpProbe {
  options: AcpConfigOption[]
  loading: boolean
  error: string | null
}

export interface OpenFile {
  path: string
  line?: number
  /** Bumped to force a reload when the same file is opened again. */
  nonce: number
}

export type PanelTab = (
  | { id: string; type: 'file'; path: string; title: string }
  | { id: string; type: 'browser'; title: string }
  | { id: string; type: 'terminal'; title: string; cwd: string; chatId: string | null }
  | { id: string; type: 'review'; title: string; cwd: string; chatId: string | null }
  | { id: string; type: 'agent'; title: string; agentId: string; chatId: string; root: string | null }
  | { id: string; type: 'files'; title: string; projectId: string; chatId: string | null; root: string }
) & { pinned?: boolean; customTitle?: string; nonce?: number }

interface Prefs {
  models: Partial<Record<Subscription, string>>
  efforts: Record<string, Effort>
  ultra: Record<string, boolean>
  fast: Record<string, boolean>
  /** Last values picked per ACP agent, so new chats start where the user left off. */
  acp: Record<string, Record<string, string>>
  lastProjectId: string | null
}

const PREFS_KEY = 'galaxy.prefs'

function loadPrefs(): Prefs {
  try {
    return { models: {}, efforts: {}, ultra: {}, fast: {}, acp: {}, lastProjectId: null, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }
  } catch {
    return { models: {}, efforts: {}, ultra: {}, fast: {}, acp: {}, lastProjectId: null }
  }
}

function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // storage unavailable
  }
}

const prefs = loadPrefs()

interface State {
  ready: boolean
  platform: string
  homeDir: string
  version: string
  settings: Settings
  secrets: SecretState
  projects: Project[]
  chats: Record<string, Chat>
  items: Record<string, Item[]>
  models: ResolvedModel[]
  accountStatuses: AccountStatus[]
  accountsLoading: boolean
  acpProbes: Record<string, AcpProbe>
  imageModels: ResolvedImageModel[]
  autoApprovalModel: { name: string; id: string }
  mcp: McpServerStatus[]
  browser: BrowserState
  browserStates: Record<string, BrowserState>
  terminalOutput: Record<string, { text: string; exited: boolean }>

  activeChatId: string | null
  draft: Draft
  /** Unsent composer text per chat, 'new' for the new chat screen. */
  composerText: Record<string, string>
  composerAttachments: Record<string, Attachment[]>
  /** Explicit activity collapses survive group changes and chat navigation. */
  activityCollapsed: Record<string, boolean>

  sidebarOpen: boolean
  panelOpen: boolean
  panelTab: string
  panelTabs: PanelTab[]
  openFiles: OpenFile[]
  settingsOpen: SettingsSection | null
  toast: { id: number; text: string; tone: 'info' | 'error' } | null

  init(): Promise<void>
  selectChat(chatId: string | null): void
  newChat(projectId?: string | null): void
  setDraft(patch: Partial<Draft>): void
  pickModel(modelKey: string): void
  pickSubscription(subscription: Subscription): void
  refreshAccounts(): Promise<void>
  loadAcpOptions(agentId: string, fresh?: boolean): Promise<void>
  setAcpOption(optionId: string, value: string): void
  setRunOptions(patch: { effort?: Effort | null; ultra?: boolean; fast?: boolean }): void
  setPermissionMode(mode: PermissionMode): void
  send(text: string, attachments: Attachment[], mentions?: PromptMentions): Promise<void>
  updateSettings(patch: Partial<Settings>): Promise<void>
  openFile(path: string, line?: number): void
  closeFile(path: string): void
  showBrowser(tabId?: string, background?: boolean): void
  addPanelTab(tab: PanelTab, background?: boolean): void
  closePanelTab(id: string): void
  createPanelTab(type: 'browser' | 'file' | 'terminal' | 'review', cwd: string | null, replaceId?: string, afterId?: string): Promise<void>
  updatePanelTab(id: string, patch: { pinned?: boolean; customTitle?: string; nonce?: number }): void
  movePanelTab(id: string, direction: -1 | 1): void
  duplicatePanelTab(id: string): Promise<void>
  reloadPanelTab(id: string): Promise<void>
  openAgent(chatId: string, agentId: string, title: string, root: string | null): void
  setPanel(open: boolean, tab?: string): void
  setComposerText(key: string, text: string): void
  setComposerAttachments(key: string, attachments: Attachment[]): void
  setActivityCollapsed(key: string, collapsed: boolean): void
  notify(text: string, tone?: 'info' | 'error'): void
}

const EMPTY_BROWSER: BrowserState = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, agentActive: false }

function draftFor(models: ResolvedModel[], settings: Settings, projectId: string | null): Draft {
  const model = defaultModel(models, settings.defaultModelKey)
  const key = model?.key ?? ''
  return {
    projectId,
    workspace: 'local',
    modelKey: key,
    effort: model ? normalizeEffort(model, prefs.efforts[key] ?? null) : null,
    ultra: !!model?.ultraEffort && prefs.ultra[key] === true,
    fast: !!model?.fastMode && prefs.fast[key] === true,
    permissionMode: settings.defaultPermissionMode,
    acpConfig: acpPrefs(model?.subscription)
  }
}

function acpPrefs(subscription: Subscription | undefined): Record<string, string> | undefined {
  const agentId = acpAgentFor(subscription)
  return agentId ? { ...(prefs.acp?.[agentId] ?? {}) } : undefined
}

export const useStore = create<State>((set, get) => {
  let openingNewTab: Promise<void> | null = null
  let accountRefresh: Promise<void> | null = null
  let initialization: Promise<void> | null = null
  const itemLoads = new Map<string, ChatEvent[]>()

  const applyChatEvent = (event: ChatEvent): void => {
    if (event.type === 'item' || event.type === 'delta' || event.type === 'items-reset') {
      const pending = itemLoads.get(event.chatId)
      if (pending) {
        pending.push(event)
        return
      }
    }
    switch (event.type) {
      case 'chat':
        set((s) => ({ chats: { ...s.chats, [event.chat.id]: event.chat } }))
        if (event.chat.unread && get().activeChatId === event.chat.id && document.hasFocus()) {
          void window.galaxy.chats.markRead(event.chat.id)
        }
        break
      case 'chat-removed':
        itemLoads.delete(event.chatId)
        set((s) => {
          const chats = { ...s.chats }
          const items = { ...s.items }
          delete chats[event.chatId]
          delete items[event.chatId]
          const activityCollapsed = Object.fromEntries(Object.entries(s.activityCollapsed).filter(([key]) => !key.startsWith(`${event.chatId}:`)))
          return { chats, items, activityCollapsed, activeChatId: s.activeChatId === event.chatId ? null : s.activeChatId }
        })
        break
      case 'item':
        set((s) => {
          const list = s.items[event.chatId]
          if (!list) return s
          const index = list.findIndex((i) => i.id === event.item.id)
          const next = index >= 0 ? list.map((i, n) => (n === index ? event.item : i)) : [...list, event.item]
          return { items: { ...s.items, [event.chatId]: next } }
        })
        break
      case 'delta':
        set((s) => {
          const list = s.items[event.chatId]
          if (!list) return s
          const index = list.findIndex((i) => i.id === event.itemId)
          if (index < 0) return s
          const item = list[index] as unknown as Record<string, unknown>
          const previous = (item[event.field] as string | undefined) ?? ''
          // Snapshots and replayed events may already contain part of this chunk.
          const unseen = event.delta.slice(Math.max(0, previous.length - event.offset))
          if (!unseen) return s
          const updated = { ...item, [event.field]: previous + unseen } as unknown as Item
          const next = list.slice()
          next[index] = updated
          return { items: { ...s.items, [event.chatId]: next } }
        })
        break
      case 'items-reset':
        set((s) => ({ items: { ...s.items, [event.chatId]: event.items } }))
        break
    }
  }

  const applyUiEvent = (event: UiEvent): void => {
    switch (event.type) {
      case 'settings': {
        const previous = get().settings
        const accountsChanged = JSON.stringify(previous.accounts) !== JSON.stringify(event.settings.accounts) || previous.acpEnabled !== event.settings.acpEnabled
        set({ settings: event.settings, secrets: event.secrets, models: resolveModels(event.settings), ...(accountsChanged ? { acpProbes: {} } : {}) })
        if (accountsChanged) void get().refreshAccounts()
        break
      }
      case 'projects':
        set({ projects: event.projects })
        break
      case 'mcp-status':
        set({ mcp: event.statuses })
        break
      case 'browser-state':
        set((s) => ({ browser: event.state, browserStates: { ...s.browserStates, [event.tabId ?? 'browser']: event.state } }))
        break
      case 'terminal-output':
        set((s) => ({ terminalOutput: { ...s.terminalOutput, [event.tabId]: { text: ((s.terminalOutput[event.tabId]?.text ?? '') + event.text).slice(-200_000), exited: event.exited ?? s.terminalOutput[event.tabId]?.exited ?? false } } }))
        break
      case 'close-panel-tab':
        get().closePanelTab(event.tabId)
        break
      case 'open-panel':
        if (event.chatId === get().activeChatId) {
          if (event.tabId) get().addPanelTab({ id: event.tabId, type: event.pane, title: event.pane === 'terminal' ? 'Terminal' : 'Review', cwd: event.cwd, chatId: event.chatId })
          else void get().createPanelTab(event.pane, event.cwd)
        }
        break
      case 'open-file':
        if (event.chatId === get().activeChatId) get().openFile(event.path, event.line)
        break
      case 'open-browser':
        get().showBrowser(event.tabId, event.background)
        break
      case 'open-browser-tab':
        get().showBrowser(event.tabId, event.background)
        break
      case 'menu':
        if (event.action === 'new-chat') get().newChat()
        else if (event.action === 'settings') set({ settingsOpen: 'general' })
        else if (event.action === 'toggle-sidebar') set((s) => ({ sidebarOpen: !s.sidebarOpen }))
        else if (event.action === 'toggle-panel') get().setPanel(!get().panelOpen)
        break
    }
  }

  return {
    ready: false,
    platform: 'darwin',
    homeDir: '',
    version: '',
    settings: {} as Settings,
    secrets: { openRouterKey: false, openRouterKeyHint: null },
    projects: [],
    chats: {},
    items: {},
    models: [],
    accountStatuses: [],
    accountsLoading: false,
    acpProbes: {},
    imageModels: resolveImageModels(),
    autoApprovalModel: { name: '', id: '' },
    mcp: [],
    browser: EMPTY_BROWSER,
    browserStates: {},
    terminalOutput: {},

    activeChatId: null,
    draft: { projectId: null, workspace: 'local', modelKey: '', effort: null, ultra: false, fast: false, permissionMode: 'auto' },
    composerText: {},
    composerAttachments: {},
    activityCollapsed: {},

    sidebarOpen: true,
    panelOpen: false,
    panelTab: '',
    panelTabs: [],
    openFiles: [],
    settingsOpen: null,
    toast: null,

    setActivityCollapsed(key, collapsed) {
      set((s) => ({ activityCollapsed: { ...s.activityCollapsed, [key]: collapsed } }))
    },

    init() {
      // React StrictMode can mount the app twice while bootstrap is still pending.
      if (initialization) return initialization
      initialization = (async () => {
        const boot = await window.galaxy.bootstrap()
        const chats: Record<string, Chat> = {}
        for (const chat of boot.chats) chats[chat.id] = chat
        const lastProject = boot.projects.some((p) => p.id === prefs.lastProjectId) ? prefs.lastProjectId : null
        set({
          ready: true,
          platform: boot.platform,
          homeDir: boot.homeDir,
          version: boot.version,
          settings: boot.settings,
          secrets: boot.secrets,
          projects: boot.projects,
          chats,
          models: boot.models,
          imageModels: boot.imageModels,
          autoApprovalModel: boot.autoApprovalModel,
          mcp: boot.mcp,
          draft: draftFor(boot.models, boot.settings, lastProject)
        })
        window.galaxy.onChatEvent(applyChatEvent)
        window.galaxy.onUiEvent(applyUiEvent)
        await window.galaxy.windows.ready()
        void window.galaxy.browser.state().then((browser) => set({ browser }))
        void get().refreshAccounts()
      })().catch((error: unknown) => {
        initialization = null
        throw error
      })
      return initialization
    },

    selectChat(chatId) {
      set({ activeChatId: chatId })
      if (!chatId) return
      if (!get().items[chatId] && !itemLoads.has(chatId)) {
        const pending: ChatEvent[] = []
        itemLoads.set(chatId, pending)
        void window.galaxy.chats.items(chatId).then((items) => {
          if (itemLoads.get(chatId) !== pending) return
          itemLoads.delete(chatId)
          set((s) => ({ items: { ...s.items, [chatId]: items } }))
          for (const event of pending) applyChatEvent(event)
        }).catch(() => {
          if (itemLoads.get(chatId) !== pending) return
          itemLoads.delete(chatId)
          get().notify('Could not load this conversation. Try opening it again.', 'error')
        })
      }
      if (get().chats[chatId]?.unread) void window.galaxy.chats.markRead(chatId)
    },

    newChat(projectId) {
      const s = get()
      const target = projectId !== undefined ? projectId : s.draft.projectId
      const subscriptions = availableSubscriptions(s.settings, s.accountStatuses)
      set({ activeChatId: null, settingsOpen: null, draft: { ...draftFor(s.models.filter((model) => subscriptions.includes(model.subscription)), s.settings, target), permissionMode: s.draft.permissionMode } })
    },

    setDraft(patch) {
      set((s) => ({ draft: { ...s.draft, ...patch } }))
      if (patch.projectId !== undefined) {
        prefs.lastProjectId = patch.projectId
        savePrefs(prefs)
      }
    },

    pickModel(modelKey) {
      const s = get()
      const model = findModel(s.models, modelKey)
      if (!model?.enabled || !availableSubscriptions(s.settings, s.accountStatuses).includes(model.subscription)) return
      prefs.models[model.subscription] = modelKey
      savePrefs(prefs)
      const next = {
        modelKey,
        effort: normalizeEffort(model, prefs.efforts[modelKey] ?? null),
        ultra: !!model.ultraEffort && prefs.ultra[modelKey] === true,
        fast: model.fastMode && prefs.fast[modelKey] === true,
        acpConfig: acpPrefs(model.subscription)
      }
      if (s.activeChatId) {
        const { acpConfig, ...rest } = next
        // Keep the chat's own picks when the model is unchanged.
        const sameModel = s.chats[s.activeChatId]?.modelKey === modelKey
        void window.galaxy.chats.update(s.activeChatId, sameModel || !acpConfig ? rest : next)
      }
      else set({ draft: { ...s.draft, ...next } })
      void s.updateSettings({ defaultModelKey: modelKey })
    },

    pickSubscription(subscription) {
      const s = get()
      if (!availableSubscriptions(s.settings, s.accountStatuses).includes(subscription)) return
      const models = s.models.filter((model) => model.enabled && model.subscription === subscription)
      const current = findModel(s.models, s.activeChatId ? s.chats[s.activeChatId]?.modelKey : s.draft.modelKey)
      const remembered = models.find((model) => model.key === prefs.models[subscription])
      const matching = models.find((model) => model.name === current?.name)
      const model = current?.enabled && current.subscription === subscription ? current : remembered ?? matching ?? models[0]
      if (model) s.pickModel(model.key)
    },

    refreshAccounts() {
      if (accountRefresh) return accountRefresh
      set({ accountsLoading: true })
      accountRefresh = (async () => {
        try {
          const accountStatuses = await window.galaxy.accounts.status()
          set({ accountStatuses })
          const s = get()
          const subscriptions = availableSubscriptions(s.settings, accountStatuses)
          const model = findModel(s.models, s.draft.modelKey)
          if (model && !subscriptions.includes(model.subscription)) {
            const draft = draftFor(s.models.filter((entry) => subscriptions.includes(entry.subscription)), s.settings, s.draft.projectId)
            set({ draft: { ...s.draft, modelKey: draft.modelKey, effort: draft.effort, ultra: draft.ultra, fast: draft.fast } })
          }
        } catch {
          // A failed check must not leave stale signed-in providers selectable.
          set({ accountStatuses: [] })
        } finally {
          set({ accountsLoading: false })
          accountRefresh = null
        }
      })()
      return accountRefresh
    },

    async loadAcpOptions(agentId, fresh = false) {
      const current = get().acpProbes[agentId]
      if (current?.loading || (current && !current.error && !fresh)) return
      const projectId = get().activeChatId ? (get().chats[get().activeChatId as string]?.projectId ?? null) : get().draft.projectId
      set((s) => ({ acpProbes: { ...s.acpProbes, [agentId]: { options: current?.options ?? [], loading: true, error: null } } }))
      try {
        const options = await window.galaxy.acp.options(agentId, projectId, fresh)
        set((s) => ({ acpProbes: { ...s.acpProbes, [agentId]: { options, loading: false, error: null } } }))
      } catch (err) {
        const message = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)
        set((s) => ({ acpProbes: { ...s.acpProbes, [agentId]: { options: current?.options ?? [], loading: false, error: message } } }))
      }
    },

    setAcpOption(optionId, value) {
      const s = get()
      const chat = s.activeChatId ? s.chats[s.activeChatId] : null
      const agentId = acpAgentFor(findModel(s.models, chat ? chat.modelKey : s.draft.modelKey)?.subscription)
      if (!agentId) return
      prefs.acp = { ...prefs.acp, [agentId]: { ...(prefs.acp?.[agentId] ?? {}), [optionId]: value } }
      savePrefs(prefs)
      if (chat) {
        // Show the pick right away; the main process applies it on the next turn.
        set({ chats: { ...s.chats, [chat.id]: { ...chat, acpConfig: { ...(chat.acpConfig ?? {}), [optionId]: value } } } })
        void window.galaxy.chats.update(chat.id, { acpConfig: { [optionId]: value } })
      } else set({ draft: { ...s.draft, acpConfig: { ...(s.draft.acpConfig ?? {}), [optionId]: value } } })
    },

    setRunOptions(patch) {
      const s = get()
      const chat = s.activeChatId ? s.chats[s.activeChatId] : null
      const key = chat ? chat.modelKey : s.draft.modelKey
      if (patch.effort) prefs.efforts[key] = patch.effort
      if (patch.ultra !== undefined) prefs.ultra[key] = patch.ultra
      if (patch.fast !== undefined) prefs.fast[key] = patch.fast
      savePrefs(prefs)
      if (chat) void window.galaxy.chats.update(chat.id, patch)
      else set({ draft: { ...s.draft, ...patch } })
    },

    setPermissionMode(mode) {
      const s = get()
      if (s.activeChatId) void window.galaxy.chats.update(s.activeChatId, { permissionMode: mode })
      else set({ draft: { ...s.draft, permissionMode: mode } })
    },

    async send(text, attachments, mentions) {
      const s = get()
      const source = s.activeChatId ? s.chats[s.activeChatId] : s.draft
      const model = findModel(s.models, source?.modelKey)
      if (!model || !availableSubscriptions(s.settings, s.accountStatuses).includes(model.subscription)) {
        s.notify('Choose a model from Local or a signed-in subscription first', 'error')
        return
      }
      let chatId = s.activeChatId
      if (!chatId) {
        if (!s.draft.modelKey) {
          s.notify('Choose a model first', 'error')
          return
        }
        const chat = await window.galaxy.chats.create(s.draft)
        chatId = chat.id
        set((state) => ({
          chats: { ...state.chats, [chat.id]: chat },
          items: { ...state.items, [chat.id]: [] },
          activeChatId: chat.id,
          composerText: { ...state.composerText, new: '' },
          composerAttachments: { ...state.composerAttachments, new: [] }
        }))
      }
      await window.galaxy.chats.send({ chatId, text, attachments, mentions })
    },

    async updateSettings(patch) {
      const settings = await window.galaxy.settings.update(patch)
      set({ settings, models: resolveModels(settings) })
    },

    openFile(path, line) {
      set((s) => {
        const existing = s.openFiles.find((f) => f.path === path)
        const openFiles = existing
          ? s.openFiles.map((f) => (f.path === path ? { ...f, line, nonce: f.nonce + 1 } : f))
          : [...s.openFiles, { path, line, nonce: 0 }]
        const panelTabs = s.panelTabs.some((tab) => tab.id === path) ? s.panelTabs : [...s.panelTabs, { id: path, type: 'file' as const, path, title: path.split('/').pop() ?? path }]
        return { openFiles, panelTabs, panelOpen: true, panelTab: path }
      })
    },

    closeFile(path) {
      get().closePanelTab(path)
    },

    showBrowser(tabId = 'browser', background = false) {
      get().addPanelTab({ id: tabId, type: 'browser', title: 'Browser' }, background)
    },

    addPanelTab(tab, background = false) {
      set((s) => {
        const exists = s.panelTabs.some((entry) => entry.id === tab.id)
        if (background && exists) return s
        return { panelTabs: exists ? s.panelTabs : [...s.panelTabs, tab], ...(background ? {} : { panelOpen: true, panelTab: tab.id }) }
      })
    },

    closePanelTab(id) {
      const tab = get().panelTabs.find((entry) => entry.id === id)
      if (tab?.type === 'browser') void window.galaxy.browser.close(id).catch(() => {})
      if (tab?.type === 'terminal') void window.galaxy.terminal.close(id).catch(() => {})
      set((s) => {
        const index = s.panelTabs.findIndex((entry) => entry.id === id)
        const panelTabs = s.panelTabs.filter((entry) => entry.id !== id)
        return { panelTabs, openFiles: s.openFiles.filter((file) => panelTabs.some((tab) => tab.type === 'file' && tab.path === file.path)), panelTab: s.panelTab === id ? panelTabs[Math.max(0, index - 1)]?.id ?? '' : s.panelTab, panelOpen: panelTabs.length > 0 && s.panelOpen }
      })
    },

    async createPanelTab(type, cwd, replaceId, afterId) {
      try {
        const add = (tab: PanelTab): void => {
          const replaced = get().panelTabs.find((entry) => entry.id === replaceId)
          if (replaced?.type === 'browser') void window.galaxy.browser.close(replaced.id).catch(() => {})
          set((s) => {
            const index = s.panelTabs.findIndex((entry) => entry.id === (replaceId ?? afterId))
            const tabs = s.panelTabs.filter((entry) => entry.id !== replaceId)
            if (index < 0) tabs.push(tab)
            else tabs.splice(index + (replaceId ? 0 : 1), 0, tab)
            return { panelTabs: tabs, panelTab: tab.id, panelOpen: true }
          })
        }
        if (type === 'file') {
          const state = get()
          const chat = state.activeChatId ? state.chats[state.activeChatId] : undefined
          const project = state.projects.find((project) => project.id === (chat ? chat.projectId : state.draft.projectId))
          if (!project) return
          add({ id: `files:${crypto.randomUUID()}`, type: 'files', title: 'Files', projectId: project.id, chatId: chat?.id ?? null, root: chat?.worktree?.path ?? project.path })
          return
        }
        if (type === 'browser') { add({ id: await window.galaxy.browser.create(), type: 'browser', title: 'New tab' }); return }
        const directory = cwd ?? get().homeDir
        const id = type === 'terminal' ? await window.galaxy.terminal.create(directory) : `review:${get().activeChatId ?? directory}`
        const existing = get().panelTabs.find((tab) => tab.id === id)
        if (existing && existing.id !== replaceId) { if (replaceId) get().closePanelTab(replaceId); get().setPanel(true, id) }
        else add({ id, type, title: type === 'terminal' ? 'Terminal' : 'Review', cwd: directory, chatId: get().activeChatId })
      } catch (error) { get().notify(error instanceof Error ? error.message : String(error), 'error') }
    },

    updatePanelTab(id, patch) {
      set((s) => ({ panelTabs: s.panelTabs.map((tab) => tab.id === id ? { ...tab, ...patch } : tab).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)) }))
    },
    movePanelTab(id, direction) {
      set((s) => {
        const tabs = s.panelTabs.slice()
        const index = tabs.findIndex((tab) => tab.id === id)
        const target = index + direction
        if (index < 0 || target < 0 || target >= tabs.length || !!tabs[index].pinned !== !!tabs[target].pinned) return s
        ;[tabs[index], tabs[target]] = [tabs[target], tabs[index]]
        return { panelTabs: tabs }
      })
    },
    async duplicatePanelTab(id) {
      const source = get().panelTabs.find((tab) => tab.id === id)
      if (!source) return
      try {
        const newId = source.type === 'browser' ? await window.galaxy.browser.create() : source.type === 'terminal' ? await window.galaxy.terminal.create(source.cwd) : `tab:${crypto.randomUUID()}`
        set((s) => { const tabs = s.panelTabs.slice(); tabs.splice(tabs.findIndex((tab) => tab.id === id) + 1, 0, { ...source, id: newId, pinned: false }); return { panelTabs: tabs, panelTab: newId, panelOpen: true } })
        if (source.type === 'browser' && get().browserStates[id]?.url) await window.galaxy.browser.navigate(get().browserStates[id].url, newId)
      } catch (error) { get().notify(String(error), 'error') }
    },
    async reloadPanelTab(id) {
      const tab = get().panelTabs.find((tab) => tab.id === id)
      if (!tab) return
      if (tab.type === 'browser') await window.galaxy.browser.reload(id)
      else if (tab.type === 'file') set((s) => ({ openFiles: s.openFiles.map((file) => file.path === tab.path ? { ...file, nonce: file.nonce + 1 } : file) }))
      else if (tab.type === 'agent') { const items = await window.galaxy.chats.items(tab.chatId); set((s) => ({ items: { ...s.items, [tab.chatId]: items } })) }
      else get().updatePanelTab(id, { nonce: (tab.nonce ?? 0) + 1 })
    },

    openAgent(chatId, agentId, title, root) {
      get().addPanelTab({ id: `agent:${chatId}:${agentId}`, type: 'agent', title, chatId, agentId, root })
    },

    setPanel(open, tab) {
      if (open && !get().panelOpen && !tab) {
        const blank = get().panelTabs.find((entry) => entry.type === 'browser' && entry.title === 'New tab' && !get().browserStates[entry.id]?.url)
        set({ panelOpen: true, panelTab: blank?.id ?? get().panelTab })
        if (!blank && !openingNewTab) {
          openingNewTab = get().createPanelTab('browser', null).finally(() => { openingNewTab = null })
        }
        return
      }
      set((s) => ({ panelOpen: open, panelTab: tab ?? s.panelTab }))
    },

    setComposerText(key, text) {
      set((s) => ({ composerText: { ...s.composerText, [key]: text } }))
    },

    setComposerAttachments(key, attachments) {
      set((s) => ({ composerAttachments: { ...s.composerAttachments, [key]: attachments } }))
    },

    notify(text, tone = 'info') {
      const id = Date.now()
      set({ toast: { id, text, tone } })
      setTimeout(() => {
        if (get().toast?.id === id) set({ toast: null })
      }, 4200)
    }
  }
})

/** The chat on screen, or null on the new chat screen. */
export function useActiveChat(): Chat | null {
  return useStore((s) => (s.activeChatId ? (s.chats[s.activeChatId] ?? null) : null))
}

/** Model and run options currently in effect, from the open chat or the draft. */
export function useRunConfig(): {
  model: ResolvedModel | null
  subscription: Subscription | null
  effort: Effort | null
  ultra: boolean
  fast: boolean
  permissionMode: PermissionMode
  /** Set when the model is an ACP agent, whose own session options replace effort and Fast. */
  acp: { agentId: string; options: AcpConfigOption[]; values: Record<string, string>; loading: boolean; error: string | null } | null
} {
  const chat = useActiveChat()
  const draft = useStore((s) => s.draft)
  const models = useStore((s) => s.models)
  const settings = useStore((s) => s.settings)
  const statuses = useStore((s) => s.accountStatuses)
  const source = chat ?? draft
  const selected = findModel(models, source.modelKey)
  const subscription = selected && availableSubscriptions(settings, statuses).includes(selected.subscription) ? selected.subscription : selected ? null : 'Default'
  const model = subscription ? selected : null
  const agentId = acpAgentFor(model?.subscription)
  const probe = useStore((s) => (agentId ? s.acpProbes[agentId] : undefined))
  const live = chat?.acpOptions?.length ? chat.acpOptions : null
  return {
    model,
    subscription,
    effort: model ? normalizeEffort(model, source.effort) : null,
    ultra: !!model?.ultraEffort && source.ultra,
    fast: !!model?.fastMode && source.fast,
    permissionMode: source.permissionMode,
    acp: agentId
      ? {
          agentId,
          options: live ?? probe?.options ?? [],
          values: source.acpConfig ?? {},
          loading: !live && (probe?.loading ?? true),
          error: live ? null : (probe?.error ?? null)
        }
      : null
  }
}
