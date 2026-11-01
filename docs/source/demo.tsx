import { createRoot } from 'react-dom/client'
import { App } from '../../src/renderer/src/App'
import { useStore } from '../../src/renderer/src/store'
import { resolveModels, resolveImageModels } from '../../src/shared/catalog'
import type { GalaxyApi } from '../../src/shared/api'
import type { Chat, ChatEvent, Item, PromptMentions, UiEvent } from '../../src/shared/types'
import { defaultSettings } from './settings'
import '../../src/renderer/src/styles.css'

const settings = defaultSettings()
settings.theme = 'dark'
settings.foldWork = false
settings.sidebarWidth = 272
settings.panelWidth = 460
const models = resolveModels(settings)
const selected = models.find((model) => model.subscription === 'Default' && !model.auto) ?? models[0]
settings.defaultModelKey = selected.key
const now = Date.now()
const projects = [
  { id: 'storefront', name: 'storefront', path: '/Projects/storefront', createdAt: now, isGit: true },
  { id: 'galaxy', name: 'galaxy-code', path: '/Projects/galaxy-code', createdAt: now, isGit: true }
]
const makeChat = (id: string, title: string, projectId = 'storefront'): Chat => ({
  id, title, projectId, createdAt: now - 60000, updatedAt: now, status: 'idle', unread: false,
  modelKey: selected.key, effort: selected.defaultEffort, ultra: false, fast: false,
  permissionMode: 'auto', workspace: 'local', worktree: null,
  usage: { inputTokens: 48200, outputTokens: 2400, contextTokens: 48200, cost: 0.12 }, queued: []
})
const chats = [makeChat('checkout', 'Fix flaky checkout test'), makeChat('auth', 'Review authentication flow'), makeChat('picker', 'Improve model picker', 'galaxy')]
const diff = { path: '/Projects/storefront/tests/e2e/checkout.spec.ts', added: 2, removed: 1, patch: "@@ -14,3 +14,4 @@\n   await page.click('#add-to-cart')\n-  await page.waitForTimeout(500)\n+  await page.waitForResponse((res) =>\n+    res.url().includes('/api/cart'))\n   await page.click('#checkout')" }
const item = (id: string, rest: Record<string, unknown>) => ({ id, ts: now - 50000, ...rest }) as Item
const history: Record<string, Item[]> = {
  checkout: [
    item('question', { kind: 'user', text: 'checkout.spec.ts fails about one run in five. Find out why and fix it.', attachments: [], revertible: true }),
    item('read', { kind: 'tool', tool: 'read', name: 'read_file', title: 'Read checkout.spec.ts', detail: 'tests/e2e/checkout.spec.ts', input: {}, status: 'done', output: 'The checkout test waits 500 ms after adding an item to the cart.' }),
    item('edit', { kind: 'tool', tool: 'edit', name: 'edit_file', title: 'Edited checkout.spec.ts', input: {}, status: 'done', meta: { diffs: [diff] }, output: 'Replaced the fixed timeout with a response wait.' }),
    item('test', { kind: 'tool', tool: 'bash', name: 'shell', title: 'Ran checkout tests', input: { command: 'npm test -- checkout' }, status: 'done', output: '✓ completes an order (1.8s)\n✓ keeps the cart after reload (1.2s)\n\nTests: 2 passed, 2 total' }),
    item('answer', { kind: 'assistant', text: 'The test waited a fixed **500 ms** for the cart to sync, but the request sometimes takes longer. It now waits for the `/api/cart` response.\n\nAll 20 repeated runs pass.' }),
    item('turn', { kind: 'turn', durationMs: 41000 })
  ],
  auth: [item('auth-q', { kind: 'user', text: 'Review the authentication flow and suggest improvements.', attachments: [] }), item('auth-a', { kind: 'assistant', text: 'The session middleware validates the token before each protected route. I would add coverage for expired sessions and make the refresh failure state clearer.' })],
  picker: [item('picker-q', { kind: 'user', text: 'Make the model picker easier to navigate.', attachments: [] }), item('picker-a', { kind: 'assistant', text: 'Models are grouped by provider, with search at the top. You can try the model picker below to explore the current UI.' })]
}
const chatListeners = new Set<(event: ChatEvent) => void>()
const uiListeners = new Set<(event: UiEvent) => void>()
const emit = (event: ChatEvent) => chatListeners.forEach((listener) => listener(event))
const ui = (event: UiEvent) => uiListeners.forEach((listener) => listener(event))
const blankBrowser = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, agentActive: false }
const browserTabs = new Map<string, { state: typeof blankBrowser; urls: string[]; index: number }>()
const files = [{ name: 'checkout.spec.ts', path: '/Projects/storefront/tests/e2e/checkout.spec.ts', relativePath: 'tests/e2e/checkout.spec.ts', directory: false }]
const fileContents = new Map<string, string>()
const browserFrames = new Map<string, HTMLIFrameElement>()
let browserSurface: HTMLIFrameElement | null = null
let shownBrowser: string | undefined
function publishBrowser(tabId: string): void {
  const tab = browserTabs.get(tabId)
  if (!tab) return
  tab.state.canGoBack = tab.index > 0
  tab.state.canGoForward = tab.index < tab.urls.length - 1
  ui({ type: 'browser-state', tabId, state: { ...tab.state } })
}
function showBrowser(rect: { x: number; y: number; width: number; height: number } | null, tabId?: string): void {
  if (!rect) { const frame = tabId ? browserFrames.get(tabId) : browserSurface; if (frame) frame.style.display = 'none'; if (!tabId || shownBrowser === tabId) { browserSurface = null; shownBrowser = undefined }; return }
  const url = tabId ? browserTabs.get(tabId)?.state.url : ''
  if (!url) return
  if (!browserSurface || shownBrowser !== tabId) {
    if (browserSurface) browserSurface.style.display = 'none'
    browserSurface = tabId ? browserFrames.get(tabId) ?? null : null
    if (!browserSurface) {
    browserSurface = document.createElement('iframe')
    browserSurface.title = 'Website preview'
    browserSurface.referrerPolicy = 'no-referrer'
    browserSurface.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin allow-popups allow-downloads')
    browserSurface.style.cssText = 'position:fixed;z-index:10;border:0;background:white'
    browserSurface.src = url
    shownBrowser = tabId
    document.body.append(browserSurface)
    if (tabId) browserFrames.set(tabId, browserSurface)
    }
    shownBrowser = tabId
  } else if (browserSurface.getAttribute('src') !== url) browserSurface.src = url
  Object.assign(browserSurface.style, { display: 'block', left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px' })
}
function navigateBrowser(value: string, tabId?: string, record = true): void {
  if (!tabId) return
  const tab = browserTabs.get(tabId)
  if (!tab) return
  const address = value.trim()
  let url: URL
  try { url = new URL(/^https?:\/\//i.test(address) ? address : address.includes('.') && !/\s/.test(address) ? 'https://' + address : 'https://www.google.com/search?q=' + encodeURIComponent(address)) } catch { return }
  if (!['http:', 'https:'].includes(url.protocol)) return
  if (record) { tab.urls = tab.urls.slice(0, tab.index + 1); tab.urls.push(url.href); tab.index = tab.urls.length - 1 }
  tab.state.url = url.href
  tab.state.title = url.hostname
  publishBrowser(tabId)
  if (shownBrowser === tabId && browserSurface) browserSurface.src = url.href
}
const api: GalaxyApi = {
  bootstrap: async () => ({ settings, secrets: { openRouterKey: true, openRouterKeyHint: 'Demo account', providerKeys: {} }, projects, chats, models, imageModels: resolveImageModels(), mcp: [], platform: 'darwin', homeDir: '/Projects', version: '1.0.0' }),
  windows: { ready: async () => {}, create: async () => useStore.getState().newChat() },
  settings: {
    update: async (patch: object) => Object.assign(settings, patch), creditsLocked: async () => false,
    usage: async () => ({ openrouter: { total: 25, used: 3.2, keyLimit: null, keyRemaining: null, freeTier: false }, claude: null, codex: null }), analytics: async () => [],
    setOpenRouterKey: async () => {}, setProviderKey: async () => {}, testOpenRouterKey: async () => ({ ok: true, message: 'Interactive demo' }), testProviderKey: async () => ({ ok: true, message: 'Interactive demo' }), signInOpenRouter: async () => ({ ok: false, message: 'Download Galaxy Code to connect your account.' })
  },
  accounts: { status: async () => [], login: async () => ({ ok: false, message: 'Download Galaxy Code to sign in.' }) },
  acp: { options: async () => [], answerConsent: async () => {} },
  projects: {
    git: async () => ({ isRepo: true, branch: 'main' }), pickFolder: async () => null, reveal: async () => {},
    create: async (input: { name?: string; path?: string }) => { const project = { id: crypto.randomUUID(), name: input.name || 'new-project', path: input.path || '/Projects/new-project', createdAt: Date.now(), isGit: true }; projects.push(project); ui({ type: 'projects', projects: [...projects] }); return project },
    rename: async (id: string, name: string) => { const project = projects.find((entry) => entry.id === id); if (project) project.name = name; ui({ type: 'projects', projects: [...projects] }) },
    remove: async (id: string) => ui({ type: 'projects', projects: projects.filter((project) => project.id !== id) })
  },
  chats: {
    items: async (id: string) => history[id] ?? [],
    create: async (input: Partial<Chat>) => { const chat = { ...makeChat(crypto.randomUUID(), 'New chat'), ...input }; chats.push(chat); return chat },
    update: async (id: string, patch: Partial<Chat>) => { const chat = chats.find((entry) => entry.id === id)!; Object.assign(chat, patch); emit({ type: 'chat', chat: { ...chat } }); return chat },
    send: async ({ chatId, text, attachments, mentions }: { chatId: string; text: string; attachments: unknown[]; mentions?: PromptMentions }) => {
      const chat = chats.find((entry) => entry.id === chatId)!
      const user = item(crypto.randomUUID(), { kind: 'user', text, attachments, mentions: mentions?.chips, prompt: mentions })
      history[chatId] = [...(history[chatId] ?? []), user]
      emit({ type: 'item', chatId, item: user })
      emit({ type: 'chat', chat: { ...chat, status: 'running', runStartedAt: Date.now() } })
      setTimeout(() => {
        const answer = item(crypto.randomUUID(), { kind: 'assistant', text: 'This is the interactive Galaxy Code demo. You can explore chats, switch models, adjust permissions, review changes, and edit the sample files. Download the app to run an agent on your own project.' })
        history[chatId].push(answer); emit({ type: 'item', chatId, item: answer }); emit({ type: 'chat', chat: { ...chat, status: 'idle' } })
      }, 600)
    },
    stop: async (id: string) => { const chat = chats.find((entry) => entry.id === id)!; emit({ type: 'chat', chat: { ...chat, status: 'idle' } }) },
    remove: async (chatId: string) => emit({ type: 'chat-removed', chatId }), markRead: async () => {}, approve: async () => {}, answer: async () => {}, unqueue: async () => {}, revert: async () => null, redo: async () => {}, compact: async () => {}
  },
  files: { createEntry: async (_projectId, parent, name, directory) => { const entry = { name, path: '/Projects/storefront/' + parent + '/' + name, relativePath: [parent, name].filter(Boolean).join('/'), directory }; files.push(entry); return entry }, renameEntry: async (_projectId, relativePath, name) => { const entry = files.find((file) => file.relativePath === relativePath)!; entry.name = name; entry.relativePath = relativePath.split('/').slice(0, -1).concat(name).join('/'); return entry }, trashEntry: async (_projectId, relativePath) => { const index = files.findIndex((file) => file.relativePath === relativePath); if (index >= 0) files.splice(index, 1) }, copyEntries: async () => [], attachFromData: async (name, mime, base64) => ({ id: crypto.randomUUID(), name, mime, path: '/demo/' + name, size: base64.length, preview: 'data:' + mime + ';base64,' + base64 }), listProject: async () => files, searchProject: async () => files, read: async (path: string) => ({ path, name: path.split('/').pop() ?? path, kind: 'text', mime: 'text/plain', size: 300, content: fileContents.get(path) ?? "test('completes an order', async ({ page }) => {\n  await page.goto('/products/mug')\n  await page.click('#add-to-cart')\n  await page.waitForResponse((res) =>\n    res.url().includes('/api/cart'))\n  await page.click('#checkout')\n})\n", language: 'typescript' }), write: async (path: string, content: string) => { fileContents.set(path, content) }, pickAttachments: async () => [], attachFromPaths: async () => [], reveal: async () => {}, openExternal: async () => {}, pathForFile: () => '' },
  editor: { complete: async () => ({ text: '', offset: 0, next: null }), suggestEdit: async () => null, inlineEdit: async () => '', cancelInlineEdit: async () => {}, terminalCommand: async () => '' },
  skills: { list: async () => [], openFolder: async () => {} }, mcp: { reconnect: async () => {} },
  browser: {
    state: async (id) => ({ ...((id ? browserTabs.get(id)?.state : null) ?? blankBrowser) }),
    frame: async () => null,
    create: async () => { const id = crypto.randomUUID(); browserTabs.set(id, { state: { ...blankBrowser }, urls: [], index: -1 }); setTimeout(() => publishBrowser(id), 0); return id },
    setTabOrder: async () => {},
    close: async (id) => { browserTabs.delete(id); showBrowser(null, id); browserFrames.get(id)?.remove(); browserFrames.delete(id) },
    setBounds: async (rect, id) => showBrowser(rect, id),
    navigate: async (url, id) => navigateBrowser(url, id),
    back: async (id) => { const tab = id && browserTabs.get(id); if (tab && tab.index > 0) navigateBrowser(tab.urls[--tab.index], id, false) },
    forward: async (id) => { const tab = id && browserTabs.get(id); if (tab && tab.index < tab.urls.length - 1) navigateBrowser(tab.urls[++tab.index], id, false) },
    reload: async (id) => { if (id && shownBrowser === id && browserSurface) browserSurface.src = browserTabs.get(id)?.state.url ?? 'about:blank' },
    stop: async () => {}, clearData: async () => {}
  },
  computer: { permissions: async () => ({ accessibility: true, screen: true }), requestPermission: async () => {}, searchApps: async () => [], watch: async () => {} },
  terminal: { create: async () => { const id = crypto.randomUUID(); setTimeout(() => ui({ type: 'terminal-output', tabId: id, text: '\r\nGalaxy Code demo terminal\r\n$ ' }), 200); return id }, write: async (tabId: string, text: string) => ui({ type: 'terminal-output', tabId, text: text === '\r' ? '\r\nDemo terminal — download the app to run commands.\r\n$ ' : text }), resize: async () => {}, interrupt: async () => {}, close: async () => {} },
  worktree: { status: async () => null, merge: async () => ({ merged: true, hash: null, conflicts: [] }), update: async () => ({ merged: true, hash: null, conflicts: [] }) },
  review: { status: async () => ({ isRepo: true }), read: async () => ({ isRepo: true, diffs: [diff] }), commits: async () => [], state: async () => ({ isRepo: true, dirty: true, hasRemote: true }), init: async () => {}, push: async () => ({ branch: 'main', remote: 'origin' }), instantCommit: async () => ({ hash: 'demo123', message: 'Fix checkout response wait', pushed: null }) },
  onChatEvent: (listener: (event: ChatEvent) => void) => { chatListeners.add(listener); return () => chatListeners.delete(listener) },
  onUiEvent: (listener: (event: UiEvent) => void) => { uiListeners.add(listener); return () => uiListeners.delete(listener) }
}
window.galaxy = api
const syncTerminalBorder = (): void => {
  const { panelTab, panelTabs } = useStore.getState()
  document.documentElement.classList.toggle('demo-terminal-active', panelTabs.some((tab) => tab.id === panelTab && tab.type === 'terminal'))
}
useStore.subscribe(syncTerminalBorder)
useStore.getState().init().then(async () => {
  useStore.getState().selectChat('checkout')
  await useStore.getState().createPanelTab('review', projects[0].path)
  await useStore.getState().createPanelTab('terminal', projects[0].path)
  await useStore.getState().createPanelTab('browser', projects[0].path)
  useStore.getState().setPanel(true, 'review:checkout')
})
createRoot(document.getElementById('root')!).render(<App />)
window.addEventListener('message', (event) => {
  if (event.source !== window.parent || !event.data || event.data.type !== 'galaxy-demo-theme') return
  void useStore.getState().updateSettings({ theme: event.data.theme === 'light' ? 'light' : 'dark' })
})
