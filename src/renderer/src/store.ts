import { createContext, useContext } from 'react'
import { create } from 'zustand'
import { availableSubscriptions, canUseChatSubscription, defaultModel, findModel, normalizeEffort, resolveImageModels, resolveModels } from '@shared/catalog'
import {
  acpAgentFor,
  applyCustomAcpAgents,
  type AccountStatus,
  type AcpConfigOption,
  type AgentMode,
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

export type SettingsSection = 'general' | 'models' | 'providers' | 'accounts' | 'usage' | 'acp' | 'mcp' | 'skills'

export interface Draft {
  projectId: string | null
  workspace: WorkspaceMode
  modelKey: string
  effort: Effort | null
  ultra: boolean
  fast: boolean
  /** With fast on, runs at the Ultrafast tier. */
  ultrafast: boolean
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

/** The side panel's tabs, which belong to one chat. */
export interface ChatPanel {
  panelTabs: PanelTab[]
  panelTab: string
  panelOpen: boolean
  openFiles: OpenFile[]
}

const EMPTY_PANEL: ChatPanel = { panelTabs: [], panelTab: '', panelOpen: false, openFiles: [] }

const panelKey = (chatId: string | null, projectId: string | null): string => chatId ?? `draft:${projectId ?? 'none'}`

/** Ends what a tab keeps running in the main process. */
function disposeTab(tab: PanelTab): void {
  if (tab.type === 'browser') void window.galaxy.browser.close(tab.id).catch(() => {})
  if (tab.type === 'terminal') void window.galaxy.terminal.close(tab.id).catch(() => {})
  if (tab.type === 'side') void window.galaxy.chats.remove(tab.chatId).catch(() => {})
}

export interface OpenFile {
  path: string
  line?: number
  /** Bumped to force a reload when the same file is opened again. */
  nonce: number
}

/** A terminal tab, or text selected in it, to mention in the composer. */
export interface QueuedMention {
  kind: 'terminal'
  name: string
  tabId: string
  cwd: string
  selection?: string
}

export type PanelTab = (
  | { id: string; type: 'file'; path: string; title: string }
  | { id: string; type: 'browser'; title: string }
  | { id: string; type: 'terminal'; title: string; cwd: string; chatId: string | null }
  | { id: string; type: 'review'; title: string; cwd: string; chatId: string | null }
  | { id: string; type: 'agent'; title: string; agentId: string; chatId: string; root: string | null }
  | { id: string; type: 'side'; title: string; chatId: string; root: string | null }
  | { id: string; type: 'files'; title: string; projectId: string; chatId: string | null; root: string }
) & { pinned?: boolean; customTitle?: string; nonce?: number }

interface Prefs {
  models: Partial<Record<Subscription, string>>
  efforts: Record<string, Effort>
  ultra: Record<string, boolean>
  fast: Record<string, boolean>
  ultrafast: Record<string, boolean>
  /** Last values picked per ACP agent, so new chats start where the user left off. */
  acp: Record<string, Record<string, string>>
  lastProjectId: string | null
}

const PREFS_KEY = 'galaxy.prefs'

function loadPrefs(): Prefs {
  try {
    return { models: {}, efforts: {}, ultra: {}, fast: {}, ultrafast: {}, acp: {}, lastProjectId: null, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }
  } catch {
    return { models: {}, efforts: {}, ultra: {}, fast: {}, ultrafast: {}, acp: {}, lastProjectId: null }
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
  antigravityConsent: string | null
  attachmentPreview: Attachment | null
  imageModels: ResolvedImageModel[]
  mcp: McpServerStatus[]
  browser: BrowserState
  browserStates: Record<string, BrowserState>
  terminalOutput: Record<string, { text: string; exited: boolean }>

  activeChatId: string | null
  draft: Draft
  /** Unsent composer text per chat, 'new' for the new chat screen. */
  composerText: Record<string, string>
  composerAttachments: Record<string, Attachment[]>
  /** Ask or Plan chip in a composer, by the same keys as its text. */
  composerMode: Record<string, AgentMode | undefined>
  /** Explicit activity collapses survive group changes and chat navigation. */
  activityCollapsed: Record<string, boolean>

  sidebarOpen: boolean
  panelOpen: boolean
  panelTab: string
  panelTabs: PanelTab[]
  /** Mentions added from outside the composer, such as a terminal selection, waiting for the composer to take them. */
  mentionQueue: QueuedMention[]
  openFiles: OpenFile[]
  /** Panel tabs of the chats that are not open, by chat id ('new' for the draft). The open chat's are the fields above. */
  chatPanels: Record<string, ChatPanel>
  settingsOpen: SettingsSection | null
  toast: { id: number; text: string; tone: 'info' | 'error' } | null
  /** An Instant commit failure, shown in a dialog. */
  gitError: string | null

  init(): Promise<void>
  selectChat(chatId: string | null): void
  newChat(projectId?: string | null): void
  setDraft(patch: Partial<Draft>): void
  /** Run-option actions act on `chatId` when given (a side chat), else on the open chat or the draft. */
  pickModel(modelKey: string, chatId?: string | null): void
  pickSubscription(subscription: Subscription, chatId?: string | null): void
  refreshAccounts(): Promise<void>
  loadAcpOptions(agentId: string, fresh?: boolean, chatId?: string | null): Promise<void>
  setAcpOption(optionId: string, value: string, chatId?: string | null): void
  setRunOptions(patch: { effort?: Effort | null; ultra?: boolean; fast?: boolean; ultrafast?: boolean }, chatId?: string | null): void
  setPermissionMode(mode: PermissionMode, chatId?: string | null): void
  send(text: string, attachments: Attachment[], mentions?: PromptMentions, steer?: boolean, mode?: AgentMode, plan?: string, chatId?: string | null): Promise<void>
  updateSettings(patch: Partial<Settings>): Promise<void>
  openFile(path: string, line?: number): void
  openAttachment(file: Attachment): void
  closeFile(path: string): void
  showBrowser(tabId?: string, background?: boolean): void
  queueMention(mention: QueuedMention): void
  takeMentions(): QueuedMention[]
  addPanelTab(tab: PanelTab, background?: boolean): void
  /** A side chat with messages asks first unless `confirmed`; closing it deletes the chat. */
  closePanelTab(id: string, confirmed?: boolean): void
  /** Side chat tab waiting for the user to confirm closing it. */
  closingSideTab: string | null
  setClosingSideTab(id: string | null): void
  /** Opens a throwaway chat in the panel, with the current chat's model and folder. Sends `text` first when given. */
  openSideChat(text?: string, sourceChatId?: string): Promise<void>
  createPanelTab(type: 'browser' | 'file' | 'terminal' | 'review', cwd: string | null, replaceId?: string, afterId?: string): Promise<void>
  updatePanelTab(id: string, patch: { pinned?: boolean; customTitle?: string; nonce?: number }): void
  movePanelTab(id: string, direction: -1 | 1): void
  duplicatePanelTab(id: string): Promise<void>
  reloadPanelTab(id: string): Promise<void>
  openAgent(chatId: string, agentId: string, title: string, root: string | null): void
  setPanel(open: boolean, tab?: string): void
  setComposerText(key: string, text: string): void
  setComposerAttachments(key: string, attachments: Attachment[]): void
  setComposerMode(key: string, mode: AgentMode | undefined): void
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
    ultrafast: !!model?.ultrafastMode && prefs.ultrafast[key] === true,
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

  /** Puts the open chat's tabs away and brings out the next chat's. Merge the result into the same set as the activeChatId change. */
  const swapPanels = (nextChatId: string | null, nextProjectId?: string | null): Partial<State> => {
    const s = get()
    const projectId = nextProjectId === undefined ? s.draft.projectId : nextProjectId
    const from = panelKey(s.activeChatId, s.draft.projectId)
    const to = panelKey(nextChatId, projectId)
    if (from === to) return {}
    const chatPanels = { ...s.chatPanels, [from]: { panelTabs: s.panelTabs, panelTab: s.panelTab, panelOpen: s.panelOpen, openFiles: s.openFiles } }
    let next = chatPanels[to]
    if (!next && !s.activeChatId && !nextChatId && projectId !== s.draft.projectId) {
      const project = s.projects.find((entry) => entry.id === projectId)
      // Carry the browsing layout over, but never reuse old file paths or shells.
      const tabs: PanelTab[] = []
      let selected = ''
      if (project) for (const tab of s.panelTabs) {
        let replacement: PanelTab | undefined
        if (tab.type === 'files') replacement = { ...tab, id: `files:${crypto.randomUUID()}`, projectId: project.id, chatId: null, root: project.path, nonce: 0 }
        else if (tab.type === 'review') replacement = { ...tab, id: `review:${crypto.randomUUID()}`, cwd: project.path, chatId: null, nonce: 0 }
        if (replacement) {
          tabs.push(replacement)
          if (tab.id === s.panelTab) selected = replacement.id
        }
      }
      next = { panelTabs: tabs, panelTab: selected || tabs[0]?.id || '', panelOpen: s.panelOpen && tabs.length > 0, openFiles: [] }
    }
    delete chatPanels[to]
    return { chatPanels, ...(next ?? EMPTY_PANEL) }
  }

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
          // A removed chat's tabs go with it.
          const chatPanels = { ...s.chatPanels }
          for (const tab of chatPanels[event.chatId]?.panelTabs ?? []) disposeTab(tab)
          delete chatPanels[event.chatId]
          if (s.activeChatId === event.chatId) {
            for (const tab of s.panelTabs) disposeTab(tab)
            const draftKey = panelKey(null, s.draft.projectId)
            const next = chatPanels[draftKey] ?? EMPTY_PANEL
            delete chatPanels[draftKey]
            return { chats, items, activityCollapsed, chatPanels, ...next, activeChatId: null }
          }
          // A side chat's own tab may sit in the open chat or in one put away.
          const withoutSide = (panel: ChatPanel): ChatPanel => {
            const panelTabs = panel.panelTabs.filter((tab) => tab.type !== 'side' || tab.chatId !== event.chatId)
            if (panelTabs.length === panel.panelTabs.length) return panel
            const panelTab = panelTabs.some((tab) => tab.id === panel.panelTab) ? panel.panelTab : panelTabs.at(-1)?.id ?? ''
            return { ...panel, panelTabs, panelTab, panelOpen: panel.panelOpen && panelTabs.length > 0 }
          }
          for (const key of Object.keys(chatPanels)) chatPanels[key] = withoutSide(chatPanels[key])
          return { chats, items, activityCollapsed, chatPanels, ...withoutSide({ panelTabs: s.panelTabs, panelTab: s.panelTab, panelOpen: s.panelOpen, openFiles: s.openFiles }) }
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
      case 'antigravity-consent':
        set({ antigravityConsent: event.requestId })
        break
      case 'settings': {
        const previous = get().settings
        const accountsChanged = JSON.stringify(previous.accounts) !== JSON.stringify(event.settings.accounts) || previous.acpEnabled !== event.settings.acpEnabled ||
          JSON.stringify(previous.customAcpAgents) !== JSON.stringify(event.settings.customAcpAgents)
        applyCustomAcpAgents(event.settings.customAcpAgents)
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
        else if (event.action === 'open-files' || event.action === 'open-browser' || event.action === 'open-terminal') {
          const state = get()
          const chat = state.activeChatId ? state.chats[state.activeChatId] : undefined
          const project = state.projects.find((entry) => entry.id === (chat ? chat.projectId : state.draft.projectId))
          const type = event.action === 'open-files' ? 'files' : event.action === 'open-browser' ? 'browser' : 'terminal'
          const existing = state.panelTabs.find((tab) => tab.type === type && (
            tab.type === 'browser' || (tab.type === 'files' ? tab.projectId === project?.id && tab.chatId === (chat?.id ?? null) : tab.type === 'terminal' && tab.chatId === state.activeChatId)
          ))
          const browserFocused = type === 'browser' && state.panelOpen && state.panelTabs.some((tab) => tab.id === state.panelTab && tab.type === 'browser')
          if (browserFocused) void state.createPanelTab('browser', null)
          else if (existing) state.setPanel(true, existing.id)
          else void state.createPanelTab(type === 'files' ? 'file' : type, chat?.worktree?.path ?? project?.path ?? null)
        }
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
    antigravityConsent: null,
    attachmentPreview: null,
    imageModels: resolveImageModels(),
    mcp: [],
    browser: EMPTY_BROWSER,
    browserStates: {},
    terminalOutput: {},

    activeChatId: null,
    draft: { projectId: null, workspace: 'local', modelKey: '', effort: null, ultra: false, fast: false, ultrafast: false, permissionMode: 'auto' },
    composerText: {},
    composerAttachments: {},
    composerMode: {},
    activityCollapsed: {},

    sidebarOpen: true,
    panelOpen: false,
    panelTab: '',
    panelTabs: [],
    closingSideTab: null,
    mentionQueue: [],
    openFiles: [],
    chatPanels: {},
    settingsOpen: null,
    toast: null,
    gitError: null,

    setActivityCollapsed(key, collapsed) {
      set((s) => ({ activityCollapsed: { ...s.activityCollapsed, [key]: collapsed } }))
    },

    init() {
      // React StrictMode can mount the app twice while bootstrap is still pending.
      if (initialization) return initialization
      initialization = (async () => {
        const boot = await window.galaxy.bootstrap()
        applyCustomAcpAgents(boot.settings.customAcpAgents)
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
      set({ ...swapPanels(chatId), activeChatId: chatId })
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
      set({ ...swapPanels(null, target), activeChatId: null, settingsOpen: null, draft: { ...draftFor(s.models.filter((model) => subscriptions.includes(model.subscription)), s.settings, target), permissionMode: s.draft.permissionMode } })
    },

    setDraft(patch) {
      const s = get()
      const panels = !s.activeChatId && patch.projectId !== undefined ? swapPanels(null, patch.projectId) : {}
      set({ ...panels, draft: { ...s.draft, ...patch } })
      if (patch.projectId !== undefined) {
        prefs.lastProjectId = patch.projectId
        savePrefs(prefs)
      }
    },

    pickModel(modelKey, chatId) {
      const s = get()
      const id = chatId === undefined ? s.activeChatId : chatId
      const model = findModel(s.models, modelKey)
      if (!model?.enabled || !availableSubscriptions(s.settings, s.accountStatuses).includes(model.subscription)) return
      if (!canUseChatSubscription(id ? s.chats[id] : null, model.subscription)) return
      prefs.models[model.subscription] = modelKey
      savePrefs(prefs)
      const next = {
        modelKey,
        effort: normalizeEffort(model, prefs.efforts[modelKey] ?? null),
        ultra: !!model.ultraEffort && prefs.ultra[modelKey] === true,
        fast: model.fastMode && prefs.fast[modelKey] === true,
        ultrafast: model.ultrafastMode && prefs.ultrafast[modelKey] === true,
        acpConfig: acpPrefs(model.subscription)
      }
      if (id) {
        const { acpConfig, ...rest } = next
        // Keep the chat's own picks when the model is unchanged.
        const sameModel = s.chats[id]?.modelKey === modelKey
        void window.galaxy.chats.update(id, sameModel || !acpConfig ? rest : next)
      }
      else set({ draft: { ...s.draft, ...next } })
      void s.updateSettings({ defaultModelKey: modelKey })
    },

    pickSubscription(subscription, chatId) {
      const s = get()
      const id = chatId === undefined ? s.activeChatId : chatId
      if (!availableSubscriptions(s.settings, s.accountStatuses).includes(subscription)) return
      if (!canUseChatSubscription(id ? s.chats[id] : null, subscription)) return
      const models = s.models.filter((model) => model.enabled && model.subscription === subscription)
      const current = findModel(s.models, id ? s.chats[id]?.modelKey : s.draft.modelKey)
      const remembered = models.find((model) => model.key === prefs.models[subscription])
      const matching = models.find((model) => model.name === current?.name)
      const model = current?.enabled && current.subscription === subscription ? current : remembered ?? matching ?? models[0]
      if (model) s.pickModel(model.key, id)
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
            set({ draft: { ...s.draft, modelKey: draft.modelKey, effort: draft.effort, ultra: draft.ultra, fast: draft.fast, ultrafast: draft.ultrafast } })
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

    async loadAcpOptions(agentId, fresh = false, chatId) {
      const current = get().acpProbes[agentId]
      if (current?.loading || (current && !current.error && !fresh)) return
      const id = chatId === undefined ? get().activeChatId : chatId
      const projectId = id ? (get().chats[id]?.projectId ?? null) : get().draft.projectId
      set((s) => ({ acpProbes: { ...s.acpProbes, [agentId]: { options: current?.options ?? [], loading: true, error: null } } }))
      try {
        const options = await window.galaxy.acp.options(agentId, projectId, fresh)
        set((s) => ({ acpProbes: { ...s.acpProbes, [agentId]: { options, loading: false, error: null } } }))
      } catch (err) {
        const message = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)
        set((s) => ({ acpProbes: { ...s.acpProbes, [agentId]: { options: current?.options ?? [], loading: false, error: message } } }))
      }
    },

    setAcpOption(optionId, value, chatId) {
      const s = get()
      const id = chatId === undefined ? s.activeChatId : chatId
      const chat = id ? s.chats[id] : null
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

    setRunOptions(patch, chatId) {
      const s = get()
      const id = chatId === undefined ? s.activeChatId : chatId
      const chat = id ? s.chats[id] : null
      const key = chat ? chat.modelKey : s.draft.modelKey
      if (patch.effort) prefs.efforts[key] = patch.effort
      if (patch.ultra !== undefined) prefs.ultra[key] = patch.ultra
      if (patch.fast !== undefined) prefs.fast[key] = patch.fast
      if (patch.ultrafast !== undefined) prefs.ultrafast[key] = patch.ultrafast
      savePrefs(prefs)
      if (chat) void window.galaxy.chats.update(chat.id, patch)
      else set({ draft: { ...s.draft, ...patch } })
    },

    setPermissionMode(mode, chatId) {
      const s = get()
      const id = chatId === undefined ? s.activeChatId : chatId
      if (id) void window.galaxy.chats.update(id, { permissionMode: mode })
      else set({ draft: { ...s.draft, permissionMode: mode } })
    },

    async send(text, attachments, mentions, steer = false, mode, plan, targetChatId) {
      const s = get()
      const target = targetChatId === undefined ? s.activeChatId : targetChatId
      const source = target ? s.chats[target] : s.draft
      const model = findModel(s.models, source?.modelKey)
      if (!model || !availableSubscriptions(s.settings, s.accountStatuses).includes(model.subscription)) {
        s.notify('Choose a model from Local or a signed-in subscription first', 'error')
        return
      }
      let chatId = target
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
          composerAttachments: { ...state.composerAttachments, new: [] },
          // The mode chip stays on for the chat the draft became.
          composerMode: { ...state.composerMode, new: undefined, [chat.id]: state.composerMode.new }
        }))
      }
      await window.galaxy.chats.send({ chatId, text, attachments, mentions, steer, ...(mode ? { mode } : {}), ...(plan ? { plan } : {}) })
    },

    async updateSettings(patch) {
      const settings = await window.galaxy.settings.update(patch)
      applyCustomAcpAgents(settings.customAcpAgents)
      set({ settings, models: resolveModels(settings) })
    },

    openAttachment(file) {
      if (file.preview || file.mime.startsWith('image/')) set({ attachmentPreview: file })
      else get().openFile(file.path)
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

    queueMention(mention) {
      set((s) => ({ mentionQueue: [...s.mentionQueue, mention] }))
    },

    takeMentions() {
      const queued = get().mentionQueue
      if (queued.length) set({ mentionQueue: [] })
      return queued
    },

    addPanelTab(tab, background = false) {
      set((s) => {
        const exists = s.panelTabs.some((entry) => entry.id === tab.id)
        if (background && exists) return s
        return { panelTabs: exists ? s.panelTabs : [...s.panelTabs, tab], ...(background ? {} : { panelOpen: true, panelTab: tab.id }) }
      })
    },

    closePanelTab(id, confirmed = false) {
      const tab = get().panelTabs.find((entry) => entry.id === id)
      if (tab?.type === 'side') {
        if (!confirmed && (get().items[tab.chatId] ?? []).length > 0) {
          set({ closingSideTab: id, panelOpen: true, panelTab: id })
          return
        }
        set({ closingSideTab: null })
        void window.galaxy.chats.remove(tab.chatId).catch(() => {})
      }
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
      else if (tab.type === 'agent' || tab.type === 'side') { const items = await window.galaxy.chats.items(tab.chatId); set((s) => ({ items: { ...s.items, [tab.chatId]: items } })) }
      else get().updatePanelTab(id, { nonce: (tab.nonce ?? 0) + 1 })
    },

    setClosingSideTab(id) {
      set({ closingSideTab: id })
    },

    async openSideChat(text, sourceChatId) {
      const s = get()
      const parentId = sourceChatId ?? s.activeChatId
      const source = parentId ? s.chats[parentId] : undefined
      if (parentId && !source) {
        s.notify('The parent chat no longer exists.', 'error')
        return
      }
      const config = source ?? s.draft
      const model = findModel(s.models, config.modelKey)
      if (!model || !availableSubscriptions(s.settings, s.accountStatuses).includes(model.subscription)) {
        s.notify('Choose a model from Local or a signed-in subscription first', 'error')
        return
      }
      const projectId = source ? source.projectId : s.draft.projectId
      const project = s.projects.find((entry) => entry.id === projectId)
      try {
        const chat = await window.galaxy.chats.create({
          projectId,
          modelKey: config.modelKey,
          effort: config.effort,
          ultra: false,
          fast: config.fast,
          ultrafast: config.ultrafast,
          permissionMode: config.permissionMode,
          workspace: 'local',
          ...(config.acpConfig ? { acpConfig: config.acpConfig } : {}),
          side: true,
          ...(source ? { parentChatId: source.id } : {})
        })
        // The side chat starts as a copy of the main chat's timeline.
        const items = await window.galaxy.chats.items(chat.id)
        set((state) => ({ chats: { ...state.chats, [chat.id]: chat }, items: { ...state.items, [chat.id]: items } }))
        get().addPanelTab({ id: `side:${chat.id}`, type: 'side', title: 'Side chat', chatId: chat.id, root: chat.worktree?.path ?? s.projects.find((entry) => entry.id === chat.projectId)?.path ?? project?.path ?? null })
        if (text?.trim()) await window.galaxy.chats.send({ chatId: chat.id, text: text.trim(), attachments: [] })
      } catch (error) {
        get().notify(error instanceof Error ? error.message : String(error), 'error')
      }
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

    setComposerMode(key, mode) {
      set((s) => ({ composerMode: { ...s.composerMode, [key]: mode } }))
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
/** Set around a side chat's timeline and message box so they act on that chat instead of the open one. */
export const ChatScope = createContext<string | null>(null)

/** The chat the surrounding UI acts on: the scoped side chat, else the open chat. */
export function useChatId(): string | null {
  const scoped = useContext(ChatScope)
  const active = useStore((s) => s.activeChatId)
  return scoped ?? active
}

export function useActiveChat(): Chat | null {
  const id = useChatId()
  return useStore((s) => (id ? (s.chats[id] ?? null) : null))
}

/** Model and run options currently in effect, from the open chat or the draft. */
export function useRunConfig(): {
  model: ResolvedModel | null
  subscription: Subscription | null
  effort: Effort | null
  ultra: boolean
  fast: boolean
  ultrafast: boolean
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
    ultrafast: !!model?.ultrafastMode && source.fast && source.ultrafast === true,
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
