import { app } from 'electron'
import { access, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { which } from '../util'
import type { BrowserAction, BrowserResult } from './browser'
import { ChromeCdp, type CdpParameters } from './chromeCdp'
import { ChromePage, chromePageUrl } from './chromePage'

interface TargetInfo {
  targetId: string
  type: string
  title: string
  url: string
  subtype?: string
}

async function chromeExecutable(): Promise<string> {
  if (process.platform === 'darwin') {
    for (const directory of ['/Applications', join(homedir(), 'Applications')]) {
      const path = join(directory, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')
      if (await access(path).then(() => true, () => false)) return path
    }
  }
  if (process.platform === 'linux') {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
      const path = await which(name)
      if (path) return path
    }
  }
  throw new Error('Google Chrome was not found. Install it to use Chrome control.')
}

function navigationUrl(input: string): string {
  const value = input.trim()
  const url = URL.parse(/^(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(value) ? `http://${value}` : value)
  if (!url || !chromePageUrl(url.href)) throw new Error('Use an http:// or https:// URL, a local file URL, or about:blank in Chrome.')
  return url.href
}

class ChromeBrowser {
  private connection: ChromeCdp | null = null
  private readonly tabs = new Map<string, TargetInfo>()
  private readonly pages = new Map<string, ChromePage>()
  private readonly sessions = new Map<string, ChromePage>()
  private queue: Promise<unknown> = Promise.resolve()
  private stopped = false

  /** Keep tool batches ordered so another agent cannot change a tab between dependent steps. */
  run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = (): void => reject(new DOMException('Chrome action cancelled', 'AbortError'))
      if (signal?.aborted) return cancel()
      signal?.addEventListener('abort', cancel, { once: true })
      this.queue = this.queue.then(async () => {
        signal?.removeEventListener('abort', cancel)
        if (signal?.aborted) return
        try {
          resolve(await operation())
        } catch (err) {
          reject(err)
        }
      })
    })
  }

  private async start(signal?: AbortSignal): Promise<ChromeCdp> {
    const executable = await chromeExecutable()
    const profile = join(app.getPath('userData'), 'agent-chrome-profile')
    await mkdir(profile, { recursive: true, mode: 0o700 })
    signal?.throwIfAborted()
    if (this.stopped) throw new Error('Galaxy Code is closing.')
    const connection = new ChromeCdp(executable, profile)
    this.connection = connection
    this.tabs.clear()
    this.pages.clear()
    this.sessions.clear()
    connection.onEvent = (method, params, sessionId) => this.onEvent(method, params, sessionId)
    try {
      await connection.send('Browser.getVersion', undefined, undefined, signal)
      await connection.send('Target.setDiscoverTargets', { discover: true }, undefined, signal)
      return connection
    } catch (err) {
      connection.close()
      throw err
    }
  }

  private onEvent(method: string, params: CdpParameters, sessionId?: string): void {
    if (sessionId) {
      this.sessions.get(sessionId)?.event(method, params)
      return
    }
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      const info = params.targetInfo as TargetInfo
      if (info.type === 'page' && !info.subtype) this.tabs.set(info.targetId, info)
    } else if (method === 'Target.targetDestroyed') {
      const id = String(params.targetId)
      this.tabs.delete(id)
      this.removePage(id)
    } else if (method === 'Target.detachedFromTarget') {
      const detached = this.sessions.get(String(params.sessionId))
      if (detached) for (const [id, page] of this.pages) if (page === detached) this.removePage(id)
    }
  }

  private removePage(id: string): void {
    const page = this.pages.get(id)
    if (page) this.sessions.delete(page.sessionId)
    this.pages.delete(id)
  }

  private async attach(connection: ChromeCdp, id: string): Promise<ChromePage> {
    const attached = this.pages.get(id)
    if (attached) return attached
    const { sessionId } = await connection.send<{ sessionId: string }>('Target.attachToTarget', { targetId: id, flatten: true }, undefined, undefined, 5000)
    const page = new ChromePage(connection, sessionId)
    this.sessions.set(sessionId, page)
    this.pages.set(id, page)
    try {
      await page.initialize()
      return page
    } catch (err) {
      this.removePage(id)
      void connection.send('Target.detachFromTarget', { sessionId }).catch(() => {})
      throw err
    }
  }

  private controllableTabs(): TargetInfo[] {
    return [...this.tabs.values()].filter((tab) => chromePageUrl(tab.url))
  }

  listTabs(): { tabIndex: number; title: string; url: string }[] {
    if (!this.connection?.alive) return []
    return this.controllableTabs().map((tab, index) => ({ tabIndex: index + 1, title: tab.title, url: tab.url || 'about:blank' }))
  }

  async act(action: BrowserAction, previousTabId: string | undefined, selectTab: (id: string | undefined) => void, signal?: AbortSignal): Promise<BrowserResult> {
    if (action.action === 'tabs') {
      return { text: JSON.stringify(this.listTabs(), null, 2) }
    }
    const newTab = action.action === 'create' || (action.action === 'navigate' && !previousTabId && action.tabIndex === undefined)
    const url = action.action === 'navigate' || action.action === 'create'
      ? navigationUrl(action.action === 'create' ? action.url || 'about:blank' : action.url ?? '')
      : undefined
    let connection = this.connection
    if (!connection?.alive) {
      if (!newTab) throw new Error('There are no connected Chrome tabs. Use Browser with browser: "chrome" and a create step.')
      connection = await this.start(signal)
    }
    const tabs = this.controllableTabs()
    if (action.tabIndex !== undefined && (!Number.isInteger(action.tabIndex) || action.tabIndex < 1)) throw new Error('tabIndex must be a positive integer.')
    if (action.background !== undefined && typeof action.background !== 'boolean') throw new Error('background must be true or false.')
    const background = action.background ?? (action.action !== 'create')
    let id: string
    if (newTab) {
      const { targetId } = await connection.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', background: tabs.length > 0 && background }, undefined, signal)
      id = targetId
      // Keep the new tab addressable before its targetCreated notification reaches us.
      if (!this.tabs.has(id)) this.tabs.set(id, { targetId: id, type: 'page', title: '', url: 'about:blank' })
    } else {
      if (action.action === 'close' && action.tabIndex === undefined) throw new Error('tabIndex is required to close a Chrome tab.')
      const target = action.tabIndex === undefined
        ? previousTabId ? tabs.find((tab) => tab.targetId === previousTabId) : tabs.at(-1)
        : tabs[action.tabIndex - 1]
      if (!target) throw new Error('The Chrome tab is unavailable. Use ListTabs with browser: "chrome" to refresh the indices.')
      id = target.targetId
    }
    selectTab(id)
    if (action.action === 'close') {
      await connection.send('Target.closeTarget', { targetId: id }, undefined, signal)
      const deadline = Date.now() + 3000
      while (connection.alive && this.tabs.has(id) && Date.now() < deadline) await delay(100, undefined, { signal })
      if (connection.alive && this.tabs.has(id)) throw new Error('Chrome still has this tab open. Check for a pending dialog.')
      selectTab(undefined)
      return { text: `Closed Chrome tab ${action.tabIndex}.` }
    }

    const page = await this.attach(connection, id)
    signal?.throwIfAborted()
    const result = await page.act(url === undefined ? action : { ...action, action: 'navigate', url, background }, signal)
    const tabIndex = this.controllableTabs().findIndex((tab) => tab.targetId === id) + 1
    return {
      ...result,
      tabId: id,
      tabIndex: tabIndex || undefined,
      url: this.tabs.get(id)?.url || url,
      text: `Chrome tab${tabIndex ? ` index: ${tabIndex}` : ' closed or unavailable'}\n${result.text}`
    }
  }

  close(): void {
    this.stopped = true
    this.connection?.close()
  }
}

export const chromeBrowser = new ChromeBrowser()
