import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_CHAT_EVENT, IPC_INVOKE, IPC_UI_EVENT, type GalaxyApi } from '@shared/api'
import type { ChatEvent, UiEvent } from '@shared/types'

const call =
  (path: string) =>
  (...args: unknown[]): Promise<never> =>
    ipcRenderer.invoke(IPC_INVOKE, path, args) as Promise<never>

function subscribe<T>(channel: string, listener: (event: T) => void): () => void {
  const handler = (_: unknown, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: GalaxyApi = {
  bootstrap: call('bootstrap'),
  windows: {
    create: call('windows.create'),
    ready: call('windows.ready')
  },
  settings: {
    update: call('settings.update'),
    setOpenRouterKey: call('settings.setOpenRouterKey'),
    testOpenRouterKey: call('settings.testOpenRouterKey'),
    signInOpenRouter: call('settings.signInOpenRouter')
  },
  accounts: {
    status: call('accounts.status'),
    login: call('accounts.login')
  },
  acp: {
    options: call('acp.options')
  },
  projects: {
    create: call('projects.create'),
    rename: call('projects.rename'),
    remove: call('projects.remove'),
    pickFolder: call('projects.pickFolder'),
    git: call('projects.git'),
    reveal: call('projects.reveal')
  },
  chats: {
    create: call('chats.create'),
    items: call('chats.items'),
    send: call('chats.send'),
    stop: call('chats.stop'),
    update: call('chats.update'),
    remove: call('chats.remove'),
    markRead: call('chats.markRead'),
    approve: call('chats.approve'),
    answer: call('chats.answer'),
    unqueue: call('chats.unqueue')
  },
  files: {
    listProject: call('files.listProject'),
    searchProject: call('files.searchProject'),
    pickAttachments: call('files.pickAttachments'),
    attachFromPaths: call('files.attachFromPaths'),
    attachFromData: call('files.attachFromData'),
    read: call('files.read'),
    reveal: call('files.reveal'),
    openExternal: call('files.openExternal'),
    pathForFile: (file: File) => webUtils.getPathForFile(file)
  },
  skills: {
    list: call('skills.list'),
    openFolder: call('skills.openFolder')
  },
  mcp: {
    reconnect: call('mcp.reconnect')
  },
  browser: {
    create: call('browser.create'),
    setTabOrder: call('browser.setTabOrder'),
    close: call('browser.close'),
    setBounds: call('browser.setBounds'),
    navigate: call('browser.navigate'),
    back: call('browser.back'),
    forward: call('browser.forward'),
    reload: call('browser.reload'),
    stop: call('browser.stop'),
    state: call('browser.state')
  },
  terminal: {
    create: call('terminal.create'), write: call('terminal.write'), resize: call('terminal.resize'), interrupt: call('terminal.interrupt'), close: call('terminal.close')
  },
  review: { read: call('review.read') },
  onChatEvent: (listener) => subscribe<ChatEvent>(IPC_CHAT_EVENT, listener),
  onUiEvent: (listener) => subscribe<UiEvent>(IPC_UI_EVENT, listener)
}

contextBridge.exposeInMainWorld('galaxy', api)
