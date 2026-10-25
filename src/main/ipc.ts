import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { IPC_CHAT_EVENT, IPC_INVOKE, IPC_UI_EVENT, type Rect } from '@shared/api'
import { resolveImageModels, resolveModels } from '@shared/catalog'
import type {
  AccountId,
  Attachment,
  Bootstrap,
  ChatEvent,
  CreateProjectInput,
  FileView,
  NewChatInput,
  Project,
  SendInput,
  Settings,
  UiEvent
} from '@shared/types'
import { manager } from './agent/manager'
import { initReviewRepository, readReview, reviewCommits } from './services/review'
import { accountStatuses, loginAccount } from './services/accounts'
import { answerAntigravityConsent, configureAntigravityConsent, confirmAntigravityUse } from './services/antigravityConsent'
import { probeAcpOptions } from './engines/acp'
import { browser } from './services/browser'
import { terminals } from './services/terminal'
import { copyProjectEntries, createProjectEntry, listProjectFiles, renameProjectEntry, searchProjectFiles, trashProjectEntry } from './services/projectFiles'
import { gitInfo, gitState, instantCommit, pushBranch } from './services/git'
import { disposeAccountWorkers } from './services/accountWorkers'
import { mcp } from './services/mcp'
import { signInWithOpenRouter, testKey } from './services/openrouter'
import { analyticsRows } from './services/analytics'
import { cancelInlineEdit, completeCode, inlineEdit, saveFile, terminalCommand, type CompletionRequest, type InlineEditRequest, type TerminalCommandRequest } from './services/editor'
import { usageReport } from './services/usage'
import { ensureSkillsDir, listSkills, projectSkillsDir, userSkillsDir } from './services/skills'
import { store } from './store'
import { exists, expandHome, isImagePath, looksBinary, mimeOf, newId, run } from './util'

type Handler = (...args: never[]) => unknown

const MAX_TEXT_VIEW = 1_500_000

async function attachmentFor(path: string): Promise<Attachment | null> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return null
  const mime = mimeOf(path)
  let preview: string | undefined
  if (isImagePath(path) && info.size < 6 * 1024 * 1024) {
    const data = await readFile(path)
    preview = `data:${mime};base64,${data.toString('base64')}`
  }
  return { id: newId('f_'), name: basename(path), path, mime, size: info.size, preview }
}

async function readFileView(path: string): Promise<FileView> {
  const abs = expandHome(path)
  const name = basename(abs)
  const mime = mimeOf(abs)
  const info = await stat(abs).catch(() => null)
  if (!info?.isFile()) return { path: abs, name, mime, size: 0, kind: 'missing' }
  if (isImagePath(abs) || mime === 'image/svg+xml') {
    if (info.size > 25 * 1024 * 1024) return { path: abs, name, mime, size: info.size, kind: 'binary' }
    const data = await readFile(abs)
    return { path: abs, name, mime, size: info.size, kind: 'image', dataUrl: `data:${mime};base64,${data.toString('base64')}`, content: mime === 'image/svg+xml' ? data.toString('utf8') : undefined }
  }
  const data = await readFile(abs)
  if (looksBinary(data)) return { path: abs, name, mime, size: info.size, kind: 'binary' }
  const truncated = data.length > MAX_TEXT_VIEW
  return { path: abs, name, mime, size: info.size, kind: 'text', content: data.subarray(0, MAX_TEXT_VIEW).toString('utf8'), truncated }
}

async function createProject(input: CreateProjectInput): Promise<Project> {
  const name = input.name?.trim() ?? ''
  let path = input.path?.trim() ? expandHome(input.path.trim()) : ''
  if (!path) {
    if (!name) throw new Error('Enter a name or choose a folder')
    // A name alone makes a fresh folder under Documents/Galaxy.
    const safe = name.replace(/[/\\:*?"<>|]/g, '-').trim()
    path = join(app.getPath('documents'), 'Galaxy', safe)
    if (await exists(path)) {
      const existing = store.projects.find((p) => p.path === path)
      if (existing) return existing
    }
    await mkdir(path, { recursive: true })
  } else if (!(await exists(path))) {
    throw new Error('That folder does not exist')
  }

  const existing = store.projects.find((p) => p.path === path)
  if (existing) return existing
  const git = await gitInfo(path)
  const project: Project = { id: newId('p_'), name: name || basename(path), path, createdAt: Date.now(), isGit: git.isRepo }
  store.projects.push(project)
  store.saveProjects()
  return project
}

export function registerIpc(getWindow: () => BrowserWindow | null, getWindows: () => BrowserWindow[], createWindow: () => void): {
  emitUi(event: UiEvent): void
  trackWindow(window: BrowserWindow): void
} {
  const source = new AsyncLocalStorage<BrowserWindow>()
  const ready = new Set<number>()
  const pending = new Map<number, UiEvent[]>()
  const pendingChats = new Map<number, ChatEvent[]>()
  const chatWindows = new Map<string, number>()
  const tabWindows = new Map<string, number>()
  const unownedOutput = new Map<string, UiEvent[]>()
  const requestWindow = (): BrowserWindow | null => source.getStore() ?? getWindow()
  const byId = (id?: number): BrowserWindow | null => getWindows().find((win) => win.id === id && !win.isDestroyed()) ?? null
  const chatWindow = (chatId: string): BrowserWindow | null => byId(chatWindows.get(chatId)) ?? getWindow()
  const sendUi = (win: BrowserWindow | null, event: UiEvent): void => {
    if (!win || win.isDestroyed()) return
    if (!ready.has(win.id)) {
      pending.set(win.id, [...(pending.get(win.id) ?? []), event])
      return
    }
    win.webContents.send(IPC_UI_EVENT, event)
  }
  const emitChat = (event: ChatEvent): void => {
    for (const win of getWindows()) {
      if (win.isDestroyed()) continue
      if (!ready.has(win.id)) pendingChats.set(win.id, [...(pendingChats.get(win.id) ?? []), event])
      else win.webContents.send(IPC_CHAT_EVENT, event)
    }
  }
  const emitUi = (event: UiEvent): void => {
    if (event.type === 'settings' || event.type === 'projects' || event.type === 'mcp-status' || event.type === 'inline-edit-delta') {
      for (const win of getWindows()) sendUi(win, event)
      return
    }
    let win: BrowserWindow | null = null
    if ('tabId' in event && event.tabId) win = byId(browser.windowIdForTab(event.tabId) ?? tabWindows.get(event.tabId))
    if (!win && 'chatId' in event) win = chatWindow(event.chatId)
    if (event.type === 'terminal-output' && !win) {
      unownedOutput.set(event.tabId, [...(unownedOutput.get(event.tabId) ?? []), event])
      return
    }
    win ??= requestWindow()
    if (win && 'tabId' in event && event.tabId) {
      tabWindows.set(event.tabId, win.id)
      for (const output of unownedOutput.get(event.tabId) ?? []) sendUi(win, output)
      unownedOutput.delete(event.tabId)
    }
    sendUi(win, event)
    if (event.type === 'close-panel-tab') tabWindows.delete(event.tabId)
  }
  const emitSettings = (): void => emitUi({ type: 'settings', settings: store.settings, secrets: store.secretState() })
  const emitProjects = (): void => emitUi({ type: 'projects', projects: store.projects })

  manager.connect(emitChat, emitUi)
  configureAntigravityConsent((requestId) => {
    const win = requestWindow()
    sendUi(win, { type: 'antigravity-consent', requestId })
    return win
  })
  browser.windowForChat = chatWindow
  mcp.onStatus((statuses) => emitUi({ type: 'mcp-status', statuses }))
  browser.onState((state, tabId) => emitUi({ type: 'browser-state', state, tabId }))
  browser.registerTab = (chatId, tabId, background) => emitUi({ type: 'open-browser', chatId, tabId, background })
  browser.requestNewTab = (tabId) => emitUi({ type: 'open-browser-tab', tabId, background: true })
  terminals.emit = emitUi

  const handlers: Record<string, Handler> = {
    'windows.create': createWindow,
    'windows.ready': () => {
      const win = requestWindow()
      if (!win) return
      ready.add(win.id)
      const chats = pendingChats.get(win.id) ?? []
      pendingChats.delete(win.id)
      for (const event of chats) win.webContents.send(IPC_CHAT_EVENT, event)
      const events = pending.get(win.id) ?? []
      pending.delete(win.id)
      for (const event of events) sendUi(win, event)
    },
    bootstrap: async (): Promise<Bootstrap> => {
      // Repository status can change between launches.
      await Promise.all(
        store.projects.map(async (project) => {
          project.isGit = (await gitInfo(project.path)).isRepo
        })
      )
      return {
        settings: store.settings,
        secrets: store.secretState(),
        projects: store.projects,
        chats: store.chatList(),
        models: resolveModels(store.settings),
        imageModels: resolveImageModels(),
        mcp: mcp.statuses(),
        platform: process.platform,
        homeDir: homedir(),
        version: app.getVersion()
      }
    },

    'settings.update': async (patch: Partial<Settings>): Promise<Settings> => {
      const enablingAntigravity = patch.accounts?.antigravity?.enabled === true && store.settings.accounts.antigravity?.enabled === false
      const enablingAcp = patch.acpEnabled === true && store.settings.acpEnabled === false && (patch.accounts ?? store.settings.accounts).antigravity?.enabled !== false
      if (enablingAntigravity || enablingAcp) await confirmAntigravityUse(true)
      const settings = store.saveSettings(patch)
      if (patch.mcpServers) void mcp.sync()
      // Warm utility CLIs pick up a changed account or binary path on their next start.
      if (patch.accounts) disposeAccountWorkers()
      emitSettings()
      return settings
    },
    'settings.setOpenRouterKey': (key: string | null) => {
      store.setOpenRouterKey(key)
      emitSettings()
    },
    'settings.testOpenRouterKey': () => testKey(),
    'settings.usage': () => usageReport(),
    'settings.analytics': () => analyticsRows(),
    'settings.signInOpenRouter': async () => {
      const result = await signInWithOpenRouter()
      emitSettings()
      return result
    },

    'accounts.status': () => accountStatuses(),
    'acp.answerConsent': (requestId: string, allow: boolean) => {
      const win = requestWindow()
      if (win) answerAntigravityConsent(requestId, allow === true, win.id)
    },
    'accounts.login': (id: AccountId) => loginAccount(id),
    'acp.options': (id: AccountId, projectId: string | null, fresh?: boolean) =>
      probeAcpOptions(id, (projectId && store.project(projectId)?.path) || homedir(), fresh === true),

    'projects.create': async (input: CreateProjectInput) => {
      const project = await createProject(input)
      emitProjects()
      return project
    },
    'projects.rename': (id: string, name: string) => {
      const project = store.project(id)
      if (project && name.trim()) {
        project.name = name.trim()
        store.saveProjects()
        emitProjects()
      }
    },
    'projects.remove': async (id: string) => {
      await manager.removeProjectChats(id)
      store.projects = store.projects.filter((p) => p.id !== id)
      store.saveProjects()
      emitProjects()
    },
    'projects.pickFolder': async () => {
      const win = requestWindow()
      const options = { properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[], title: 'Choose a project folder' }
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    'projects.git': async (id: string) => {
      const project = store.project(id)
      if (!project) return { isRepo: false, branch: null }
      const info = await gitInfo(project.path)
      if (project.isGit !== info.isRepo) {
        project.isGit = info.isRepo
        store.saveProjects()
        emitProjects()
      }
      return info
    },
    'projects.reveal': (id: string) => {
      const project = store.project(id)
      if (project) void shell.openPath(project.path)
    },

    'chats.create': (input: NewChatInput) => {
      const chat = manager.create(input)
      const win = requestWindow()
      if (win) chatWindows.set(chat.id, win.id)
      return chat
    },
    'chats.items': (chatId: string) => manager.items(chatId),
    'chats.send': (input: SendInput) => {
      const win = requestWindow()
      const status = store.chats.get(input.chatId)?.status
      // Queuing a follow-up in another window must not move the current run's tools.
      if (win && (!byId(chatWindows.get(input.chatId)) || (status !== 'running' && status !== 'awaiting'))) chatWindows.set(input.chatId, win.id)
      return manager.send(input)
    },
    'chats.stop': (chatId: string) => manager.stop(chatId),
    'chats.update': (chatId: string, patch: Record<string, unknown>) => manager.update(chatId, patch),
    'chats.remove': (chatId: string) => manager.remove(chatId),
    'chats.markRead': (chatId: string) => manager.markRead(chatId),
    'chats.approve': (chatId: string, approvalId: string, decision: 'allow' | 'allow-session' | 'deny', note?: string) =>
      manager.approve(chatId, approvalId, decision, note),
    'chats.answer': (chatId: string, itemId: string, answers: Record<string, string> | null) => manager.answer(chatId, itemId, answers),
    'chats.unqueue': (chatId: string, messageId: string) => manager.unqueue(chatId, messageId),
    'chats.revert': (chatId: string, itemId: string, messageOnly?: boolean) => manager.revert(chatId, itemId, messageOnly === true),
    'chats.redo': (chatId: string) => manager.redo(chatId),
    'chats.compact': (chatId: string) => manager.compact(chatId),

    'files.pickAttachments': async () => {
      const win = requestWindow()
      const options = { properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[], title: 'Attach files' }
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      if (result.canceled) return []
      return (await Promise.all(result.filePaths.map(attachmentFor))).filter((a): a is Attachment => a !== null)
    },
    'files.attachFromPaths': async (paths: string[]) =>
      (await Promise.all(paths.map(attachmentFor))).filter((a): a is Attachment => a !== null),
    'files.attachFromData': async (name: string, mime: string, base64: string) => {
      // Pasted images have no file behind them, so give them one the agent can read.
      const dir = join(store.dataDir, 'attachments')
      await mkdir(dir, { recursive: true })
      const ext = mime.split('/')[1]?.replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'png'
      const safeName = name.replace(/[^\w.-]/g, '_') || `pasted.${ext}`
      const path = join(dir, `${newId()}-${safeName.includes('.') ? safeName : `${safeName}.${ext}`}`)
      await writeFile(path, Buffer.from(base64, 'base64'))
      return attachmentFor(path)
    },
    'files.listProject': listProjectFiles,
    'files.searchProject': searchProjectFiles,
    'files.createEntry': createProjectEntry,
    'files.renameEntry': renameProjectEntry,
    'files.trashEntry': trashProjectEntry,
    'files.copyEntries': copyProjectEntries,
    'files.read': (path: string) => readFileView(path),
    'files.write': (path: string, content: string) => saveFile(path, content),
    'editor.complete': (request: CompletionRequest) => completeCode(request),
    'editor.inlineEdit': (request: InlineEditRequest) => inlineEdit(request, (text) => emitUi({ type: 'inline-edit-delta', requestId: request.requestId, text })),
    'editor.cancelInlineEdit': (requestId: string) => cancelInlineEdit(requestId),
    'editor.terminalCommand': (request: TerminalCommandRequest) => terminalCommand(request, (text) => emitUi({ type: 'inline-edit-delta', requestId: request.requestId, text })),
    'files.reveal': (path: string) => shell.showItemInFolder(expandHome(path)),
    'files.openExternal': async (target: string) => {
      if (/^(https?|mailto):/i.test(target)) await shell.openExternal(target)
      else await shell.openPath(expandHome(target))
    },

    'skills.list': (projectId: string | null) => listSkills(store.project(projectId)?.path ?? null),
    'skills.openFolder': async (scope: 'user' | 'project', projectId: string | null) => {
      const project = store.project(projectId)
      const dir = scope === 'project' && project ? projectSkillsDir(project.path) : userSkillsDir()
      await shell.openPath(await ensureSkillsDir(dir))
    },

    'mcp.reconnect': (id: string) => mcp.reconnect(id),

    'browser.create': () => browser.create(requestWindow() ?? undefined),
    'browser.setTabOrder': (ids: string[], titles?: Record<string, string>) => browser.setTabOrder(ids, titles, requestWindow() ?? undefined),
    'browser.close': (id: string) => { browser.close(id, requestWindow() ?? undefined); tabWindows.delete(id) },
    'browser.setBounds': (rect: Rect | null, id?: string) => browser.setBounds(rect, id, requestWindow() ?? undefined),
    'browser.navigate': (url: string, id?: string) => browser.navigate(url, id, requestWindow() ?? undefined),
    'browser.back': (id?: string) => browser.back(id, requestWindow() ?? undefined),
    'browser.forward': (id?: string) => browser.forward(id, requestWindow() ?? undefined),
    'browser.reload': (id?: string) => browser.reload(id, requestWindow() ?? undefined),
    'browser.stop': (id?: string) => browser.stop(id, requestWindow() ?? undefined),
    'browser.state': (id?: string) => browser.state(id, requestWindow() ?? undefined),
    'terminal.create': (cwd: string, id = newId('terminal_')) => {
      const win = requestWindow()
      if (win) tabWindows.set(id, win.id)
      return terminals.create(cwd, id)
    },
    'terminal.write': (id: string, text: string) => terminals.write(id, text),
    'terminal.resize': (id: string, cols: number, rows: number) => terminals.resize(id, cols, rows),
    'terminal.interrupt': (id: string) => terminals.interrupt(id),
    'terminal.close': (id: string) => terminals.close(id),
    'review.read': readReview,
    'review.commits': reviewCommits,
    'review.status': gitInfo,
    'review.init': initReviewRepository,
    'review.push': pushBranch,
    'review.state': gitState,
    'review.instantCommit': instantCommit
  }

  ipcMain.handle(IPC_INVOKE, async (event, path: string, args: unknown[]) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.webContents !== event.sender || !getWindows().includes(win)) throw new Error('The requesting app window is not available')
    const handler = handlers[path]
    if (!handler) throw new Error(`Unknown IPC call: ${path}`)
    return source.run(win, () => handler(...((args ?? []) as never[])))
  })

  return {
    emitUi,
    trackWindow(win) {
      win.webContents.on('did-start-loading', () => ready.delete(win.id))
      win.on('closed', () => {
        ready.delete(win.id)
        pending.delete(win.id)
        pendingChats.delete(win.id)
        for (const [chatId, windowId] of chatWindows) if (windowId === win.id) chatWindows.delete(chatId)
        for (const [tabId, windowId] of tabWindows) if (windowId === win.id) {
          terminals.close(tabId)
          tabWindows.delete(tabId)
          unownedOutput.delete(tabId)
        }
      })
    }
  }
}
