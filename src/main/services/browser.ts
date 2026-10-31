import { dialog, session, WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import type { Rect } from '@shared/api'
import type { BrowserDataKind, BrowserSearchEngine, BrowserState } from '@shared/types'
import { store } from '../store'
import { errorMessage, newId, sleep, truncateEnd } from '../util'
import { agentCursorScript, type CursorUpdate } from './browserCursor'

export interface BrowserAction {
  tabIndex?: number
  /** navigate only: true keeps the user's panel selection, false reveals the tab. */
  background?: boolean
  action:
    | 'create'
    | 'tabs'
    | 'close'
    | 'navigate'
    | 'snapshot'
    | 'click'
    | 'drag'
    | 'type'
    | 'press'
    | 'scroll'
    | 'screenshot'
    | 'evaluate'
    | 'back'
    | 'forward'
    | 'reload'
    | 'wait'
    | 'console'
    | 'dialog'
  url?: string
  ref?: number
  selector?: string
  /** A point in the pixels of the tab's latest screenshot. */
  x?: number
  y?: number
  /** drag only: where the drag ends, in the same pixels. */
  toX?: number
  toY?: number
  text?: string
  submit?: boolean
  clear?: boolean
  key?: string
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
  script?: string
  seconds?: number
  full_text?: boolean
  /** dialog only: accept (default) or dismiss the next alert, confirm or prompt. `text` answers a prompt. */
  accept?: boolean
}

export interface BrowserResult {
  text: string
  tabId?: string
  tabIndex?: number
  url?: string
  image?: { mime: string; base64: string }
}

interface LoadFailure {
  url: string
  code: number
  name: string
  description: string
}

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string)

/** What went wrong and what to try, in the words a browser would use. */
function failureCopy(failure: LoadFailure): { title: string; hint: string } {
  let host = failure.url
  try {
    host = new URL(failure.url).host || failure.url
  } catch { /* Keep the whole address. */ }
  switch (failure.name) {
    case 'ERR_CONNECTION_REFUSED':
      return { title: `${host} refused to connect.`, hint: 'Check that the server is running, and that the address and port are right. A dev server may need to be started first.' }
    case 'ERR_NAME_NOT_RESOLVED':
      return { title: `${host}'s server IP address could not be found.`, hint: 'Check the address for typos, and that you are online.' }
    case 'ERR_INTERNET_DISCONNECTED':
      return { title: 'There is no internet connection.', hint: 'Check your network cable, modem and router, or reconnect to Wi-Fi.' }
    case 'ERR_CONNECTION_TIMED_OUT':
    case 'ERR_TIMED_OUT':
      return { title: `${host} took too long to respond.`, hint: 'The server may be down or busy. Try again in a moment.' }
    case 'ERR_CONNECTION_RESET':
    case 'ERR_CONNECTION_CLOSED':
      return { title: `The connection to ${host} was interrupted.`, hint: 'Try again. If it keeps happening, the server may be restarting.' }
    case 'ERR_FILE_NOT_FOUND':
      return { title: 'This file could not be found.', hint: 'It may have been moved or deleted.' }
    default:
      return /^ERR_CERT_|^ERR_SSL_/.test(failure.name)
        ? { title: `The connection to ${host} is not private.`, hint: 'The site\'s security certificate could not be verified.' }
        : { title: `${host} could not be reached.`, hint: failure.description || 'Something went wrong while loading the page.' }
  }
}

/** The page shown in place of one that failed to load. It keeps the address in view and offers a retry. */
function failurePageUrl(failure: LoadFailure): string {
  const { title, hint } = failureCopy(failure)
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Can't reach this page</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#fff;color:#202124}
.box{max-width:480px;padding:32px}
.icon{width:44px;height:44px;border-radius:50%;border:2px solid currentColor;opacity:.55;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:600;margin-bottom:20px}
h1{font-size:20px;font-weight:600;margin:0 0 10px}
p{margin:0 0 8px;color:#5f6368}
code{font:12px ui-monospace,Menlo,monospace;color:#5f6368;word-break:break-all}
button{margin-top:18px;padding:7px 16px;border-radius:8px;border:0;background:#1a73e8;color:#fff;font:inherit;font-weight:500;cursor:pointer}
button:hover{background:#1765cc}
@media (prefers-color-scheme:dark){body{background:#202124;color:#e8eaed}p,code{color:#9aa0a6}button{background:#8ab4f8;color:#202124}button:hover{background:#aecbfa}}
</style></head><body><div class="box"><div class="icon">!</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(hint)}</p><p><code>${escapeHtml(failure.name)} (${failure.code})</code></p><p><code>${escapeHtml(failure.url)}</code></p><button id="retry">Try again</button></div><script>document.getElementById('retry').onclick=()=>location.replace(${JSON.stringify(failure.url).replace(/</g, '\\u003c')})</script></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

const HOME_URL = 'about:blank'
const SCREENSHOT_WIDTH = 1400
const PARTITION = 'persist:galaxy-browser'

const SEARCH_URLS: Record<BrowserSearchEngine, string> = {
  duckduckgo: 'https://duckduckgo.com/?q=',
  google: 'https://www.google.com/search?q=',
  bing: 'https://www.bing.com/search?q=',
  brave: 'https://search.brave.com/search?q='
}

function hasPoint(action: BrowserAction): boolean {
  return action.x !== undefined || action.y !== undefined
}

/** Tags every visible interactive element with a ref and returns an outline the model can act on. */
const SNAPSHOT_SCRIPT = `(() => {
  const MAX = 220;
  const sel = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=option],[role=combobox],[role=textbox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  document.querySelectorAll('[data-gx-ref]').forEach((el) => el.removeAttribute('data-gx-ref'));
  const clean = (s, n) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, n);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  };
  const lines = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (n >= MAX) break;
    if (!visible(el) || el.disabled) continue;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (el.type || 'text') : tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : tag === 'summary' ? 'summary' : 'button');
    const name = clean(el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name'), 90);
    if (!name && !['text','search','email','password','textarea','select','number','tel','url','checkbox','radio'].includes(role)) continue;
    n += 1;
    el.setAttribute('data-gx-ref', String(n));
    let line = '[' + n + '] ' + role + (name ? ' "' + name + '"' : '');
    if (tag === 'a') { try { const u = new URL(el.href); line += ' -> ' + (u.origin === location.origin ? u.pathname + u.search : u.href).slice(0, 100); } catch {} }
    if ((tag === 'input' || tag === 'textarea') && el.value && role !== 'password') line += ' value="' + clean(el.value, 60) + '"';
    if (role === 'checkbox' || role === 'radio' || role === 'switch') line += el.checked || el.getAttribute('aria-checked') === 'true' ? ' (checked)' : ' (unchecked)';
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) line += ' (offscreen)';
    lines.push(line);
  }
  return {
    url: location.href,
    title: document.title,
    scroll: Math.round(scrollY) + '/' + Math.max(0, Math.round(document.documentElement.scrollHeight - innerHeight)),
    elements: lines,
    text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim()
  };
})()`

function locateScript(target: { ref?: number; selector?: string }): string {
  const find =
    target.ref !== undefined
      ? `document.querySelector('[data-gx-ref="${Number(target.ref)}"]')`
      : `document.querySelector(${JSON.stringify(target.selector ?? '')})`
  return `(() => {
    const el = ${find};
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    return { x, y, hit: !!hit && (hit === el || el.contains(hit) || hit.contains(el)), tag: el.tagName.toLowerCase() };
  })()`
}

class BrowserService {
  private window: BrowserWindow | null = null
  private view: WebContentsView | null = null
  private bounds: Rect | null = null
  private viewport = { x: 0, y: 0, width: 1280, height: 800 }
  private agentActive = false
  private cursorPosition: { x: number; y: number } | null = null
  private cursorWaitingAtCenter = false
  private consoleLog: string[] = []
  private favicon = ''
  private failure: LoadFailure | null = null
  private dialogLog: string[] = []
  private dialogReply: { accept: boolean; text?: string } | null = null
  private faviconVersion = 0
  private listeners = new Set<(state: BrowserState) => void>()
  requestNewTab: (url: string, openedByAgent: boolean) => void = () => {}

  attach(window: BrowserWindow): void {
    this.window = window
    window.on('closed', () => {
      this.window = null
      this.view = null
    })
  }

  close(): void {
    if (this.view && this.window && !this.window.isDestroyed()) this.window.contentView.removeChildView(this.view)
    this.view?.webContents.close()
    this.view = null
    this.listeners.clear()
  }

  onState(listener: (state: BrowserState) => void): void {
    this.listeners.add(listener)
  }

  private emit(): void {
    const state = this.state()
    for (const listener of this.listeners) listener(state)
  }

  private ensureView(): WebContentsView {
    if (this.view) return this.view
    if (!this.window) throw new Error('The app window is not available')
    const view = new WebContentsView({
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, backgroundThrottling: false }
    })
    view.setBackgroundColor('#ffffff')
    view.setBorderRadius(8)
    view.setVisible(false)
    this.window.contentView.addChildView(view)
    this.view = view

    const wc = view.webContents
    wc.on('did-finish-load', () => {
      if (this.cursorWaitingAtCenter) void this.updateCursor({ action: 'center' })
      else if (this.agentActive && this.cursorPosition) void this.updateCursor({ action: 'show', ...this.cursorPosition })
    })
    wc.on('did-start-navigation', (_event, url, inPlace, mainFrame) => {
      if (!mainFrame || inPlace) return
      if (!url.startsWith('data:')) this.failure = null
      this.favicon = ''
      this.faviconVersion++
      this.emit()
    })
    wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // A superseded or redirected load reports ERR_ABORTED; the page still arrives.
      if (isMainFrame && code !== -3 && !url.startsWith('data:')) this.showFailure({ url, code, name: description, description })
    })
    this.watchDialogs(wc)
    wc.on('page-favicon-updated', (_event, urls) => {
      const url = urls.find((url) => /^(https?:|data:image\/)/i.test(url))
      if (!url) return
      const version = ++this.faviconVersion
      void (async () => {
        try {
          const response = await wc.session.fetch(url, { signal: AbortSignal.timeout(5000) })
          const mime = (response.headers.get('content-type') ?? '').split(';')[0]
          if (!response.ok || !mime.startsWith('image/')) return
          const data = Buffer.from(await response.arrayBuffer())
          if (version !== this.faviconVersion || data.length > 1_000_000) return
          this.favicon = `data:${mime};base64,${data.toString('base64')}`
          this.emit()
        } catch { /* Keep the fallback icon when the site has no usable favicon. */ }
      })()
    })
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (disposition === 'new-window' && store.settings.browserBlockPopups) return { action: 'deny' }
      if (/^https?:/i.test(url)) this.requestNewTab(url, this.agentActive)
      return { action: 'deny' }
    })
    for (const event of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'] as const) {
      wc.on(event as never, () => this.emit())
    }
    wc.on('console-message', (details) => {
      const event = details as unknown as { level?: string; message?: string }
      this.consoleLog.push(`[${event.level ?? 'log'}] ${event.message ?? ''}`)
      if (this.consoleLog.length > 200) this.consoleLog.splice(0, this.consoleLog.length - 200)
    })
    this.applyBounds()
    return view
  }

  private get wc(): WebContents {
    return this.ensureView().webContents
  }

  private applyBounds(): void {
    if (!this.view) return
    if (!this.bounds || this.bounds.width < 4 || this.bounds.height < 4) {
      this.view.setVisible(false)
      this.view.setBounds(this.viewport)
      return
    }
    this.viewport = {
      x: Math.round(this.bounds.x),
      y: Math.round(this.bounds.y),
      width: Math.round(this.bounds.width),
      height: Math.round(this.bounds.height)
    }
    this.view.setBounds(this.viewport)
    this.view.setVisible(true)
  }

  setBounds(rect: Rect | null): void {
    this.bounds = rect
    if (rect) this.ensureView()
    this.applyBounds()
  }

  /** The page as it looks now, to stand in for the native view while something covers it. */
  async frame(): Promise<string | null> {
    if (!this.view) return null
    const image = await this.view.webContents.capturePage()
    return image.isEmpty() ? null : `data:image/jpeg;base64,${image.toJPEG(90).toString('base64')}`
  }

  state(): BrowserState {
    const wc = this.view?.webContents
    const current = wc?.getURL() ?? ''
    // The error page stands in for the address that failed, which stays in the address bar.
    const url = this.failure && current.startsWith('data:text/html') ? this.failure.url : current
    return {
      favicon: this.favicon,
      url: url === HOME_URL ? '' : url,
      title: wc?.getTitle() ?? '',
      loading: wc?.isLoading() ?? false,
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      agentActive: this.agentActive
    }
  }

  isVisible(): boolean { return !!this.bounds }

  /** Image pixels per CSS pixel in this tab's latest screenshot, and the image's size. */
  private shot: { x: number; y: number; width: number; height: number } | null = null

  private async command(method: string, params: Record<string, unknown>): Promise<void> {
    // Dispatch to this page directly without focusing its native view or the app window.
    const debuggerApi = this.wc.debugger
    if (!debuggerApi.isAttached()) debuggerApi.attach('1.3')
    await debuggerApi.sendCommand(method, params)
  }

  private normalizeUrl(input: string): string {
    const value = input.trim()
    if (!value) return HOME_URL
    if (/^(https?|file|about|data):/i.test(value)) return value
    if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(value)) return `http://${value}`
    if (/^[^\s]+\.[^\s]{2,}$/.test(value)) return `https://${value}`
    return `${SEARCH_URLS[store.settings.browserSearchEngine]}${encodeURIComponent(value)}`
  }

  /** Replaces a page that failed to load with the error page. */
  private showFailure(failure: LoadFailure): void {
    if (this.failure?.url === failure.url && this.wc.getURL().startsWith('data:text/html')) return
    this.failure = failure
    void this.wc.loadURL(failurePageUrl(failure)).catch(() => {})
  }

  /**
   * JavaScript alert, confirm and prompt boxes, answered through the DevTools protocol. While the agent works, an
   * alert is accepted and a confirm or prompt is dismissed unless the agent said otherwise with the dialog action.
   * Otherwise the user answers in a sheet on the app window.
   */
  private watchDialogs(wc: WebContents): void {
    const api = wc.debugger
    try {
      if (!api.isAttached()) api.attach('1.3')
    } catch {
      return
    }
    api.on('message', (_event, method, params) => {
      if (method === 'Page.javascriptDialogOpening') void this.answerDialog(wc, params as { type: string; message: string; url?: string; defaultPrompt?: string })
    })
    void api.sendCommand('Page.enable').catch(() => {})
  }

  private async answerDialog(wc: WebContents, opening: { type: string; message: string; url?: string; defaultPrompt?: string }): Promise<void> {
    const kind = opening.type
    let reply = this.dialogReply
    this.dialogReply = null
    if (!reply) {
      if (this.agentActive) {
        reply = { accept: kind === 'alert' || kind === 'beforeunload' }
      } else {
        let host = ''
        try {
          host = new URL(opening.url ?? '').host
        } catch { /* The dialog has no usable address. */ }
        const ask = kind === 'confirm' || kind === 'prompt' || kind === 'beforeunload'
        const options = {
          type: 'info' as const,
          message: host ? `${host} says` : 'This page says',
          detail: kind === 'beforeunload' ? 'Leave this page? Changes you made may not be saved.' : kind === 'prompt' ? `${opening.message}\n\nDefault answer: ${opening.defaultPrompt ?? ''}` : opening.message,
          buttons: ask ? [kind === 'beforeunload' ? 'Leave' : 'OK', 'Cancel'] : ['OK'],
          defaultId: 0,
          cancelId: ask ? 1 : 0
        }
        try {
          const result = this.window && !this.window.isDestroyed() ? await dialog.showMessageBox(this.window, options) : await dialog.showMessageBox(options)
          reply = { accept: result.response === 0, ...(kind === 'prompt' ? { text: opening.defaultPrompt ?? '' } : {}) }
        } catch {
          reply = { accept: false }
        }
      }
    }
    const shown = `${kind}: ${truncateEnd(opening.message, 300)}`
    if (this.agentActive) {
      const accepted = reply.accept
      this.dialogLog.push(`A ${shown} was ${accepted ? 'accepted' : 'dismissed'}.${!accepted && (kind === 'confirm' || kind === 'prompt') ? ' Add a dialog step with accept before the action to accept it.' : ''}`)
    }
    try {
      await wc.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: reply.accept, ...(reply.text !== undefined ? { promptText: reply.text } : {}) })
    } catch { /* The dialog already went away, for example when the page navigated. */ }
  }

  async navigate(url: string, openedByAgent = false): Promise<void> {
    this.cursorWaitingAtCenter = openedByAgent || this.agentActive
    this.cursorPosition = null
    if (!this.cursorWaitingAtCenter) void this.updateCursor({ action: 'hide' })
    try {
      await this.wc.loadURL(this.normalizeUrl(url))
    } catch (err) {
      // ERR_ABORTED fires on redirects and superseded loads, the page still arrives.
      const message = errorMessage(err)
      if (/ERR_ABORTED|\(-3\)/.test(message)) { /* Fine. */ }
      else {
        // A page that cannot load shows the error page instead of raising an error.
        const failed = /(ERR_[A-Z_]+) \((-?\d+)\) loading '([^']*)'/.exec(message)
        if (!failed) throw err
        this.showFailure({ url: failed[3], code: Number(failed[2]), name: failed[1], description: failed[1] })
      }
    }
    if (this.cursorWaitingAtCenter) await this.updateCursor({ action: 'center' })
  }

  back(): void {
    if (this.view?.webContents.navigationHistory.canGoBack()) this.view.webContents.navigationHistory.goBack()
  }

  forward(): void {
    if (this.view?.webContents.navigationHistory.canGoForward()) this.view.webContents.navigationHistory.goForward()
  }

  reload(): void {
    this.view?.webContents.reload()
  }

  stop(): void {
    this.view?.webContents.stop()
  }

  // Agent control

  setAgentActive(active: boolean): void {
    if (this.agentActive !== active) {
      this.agentActive = active
      this.emit()
    }
    if (!active) {
      this.cursorWaitingAtCenter = false
      void this.updateCursor({ action: 'hide' })
    } else if (this.cursorWaitingAtCenter) void this.updateCursor({ action: 'center' })
    else if (this.cursorPosition) void this.updateCursor({ action: 'show', ...this.cursorPosition })
  }

  private async updateCursor(update: CursorUpdate): Promise<number> {
    const wc = this.view?.webContents
    if (!wc || wc.isDestroyed()) return 0
    try {
      return Number(await wc.executeJavaScriptInIsolatedWorld(1001, [{ code: agentCursorScript(update) }])) || 0
    } catch {
      // Navigation may replace the page during an animation; cursor visuals must not fail the tool.
      return 0
    }
  }

  private async settle(signal?: AbortSignal, maxMs = 15000): Promise<void> {
    const wc = this.wc
    const start = Date.now()
    await sleep(150, signal)
    while (wc.isLoading() && Date.now() - start < maxMs) await sleep(120, signal)
    await sleep(250, signal)
  }

  private async describe(includeText: boolean): Promise<string> {
    const snap = (await this.wc.executeJavaScript(SNAPSHOT_SCRIPT, true)) as {
      url: string
      title: string
      scroll: string
      elements: string[]
      text: string
    }
    const parts = [`URL: ${snap.url}`, `Title: ${snap.title}`, `Scroll: ${snap.scroll}`]
    parts.push('', snap.elements.length ? `Interactive elements:\n${snap.elements.join('\n')}` : 'No interactive elements found.')
    if (includeText) parts.push('', `Page text:\n${truncateEnd(snap.text, 12000)}`)
    return parts.join('\n')
  }

  /** Converts a point on the screenshot to the CSS pixels page input uses. */
  private async pagePoint(x: number | undefined, y: number | undefined): Promise<{ x: number; y: number }> {
    const px = Number(x)
    const py = Number(y)
    if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error('Provide both `x` and `y`')
    const page = (await this.wc.executeJavaScript('({ width: innerWidth, height: innerHeight, ratio: devicePixelRatio })', true)) as { width: number; height: number; ratio: number }
    // Before any screenshot, use the size one would have, so a point means the same either way.
    const fitted = Math.min(SCREENSHOT_WIDTH, page.width * page.ratio) / page.width
    const scale = this.shot ?? { x: fitted, y: fitted }
    const width = Math.round(page.width * scale.x)
    const height = Math.round(page.height * scale.y)
    if (px < 0 || py < 0 || px >= width || py >= height) throw new Error(`Point (${px}, ${py}) is outside the ${width}x${height} screenshot frame`)
    return { x: px / scale.x, y: py / scale.y }
  }

  private async moveCursor(point: { x: number; y: number }, signal?: AbortSignal): Promise<void> {
    this.cursorWaitingAtCenter = false
    const duration = await this.updateCursor({ action: 'move', ...point })
    if (duration) await sleep(duration, signal)
  }

  private async locate(action: BrowserAction): Promise<{ x: number; y: number; hit: boolean; tag: string }> {
    if (hasPoint(action)) return { ...(await this.pagePoint(action.x, action.y)), hit: true, tag: '' }
    if (action.ref === undefined && !action.selector) throw new Error('Provide `ref` (from a snapshot), `selector`, or `x` and `y`')
    const point = (await this.wc.executeJavaScript(locateScript(action), true)) as {
      x: number
      y: number
      hit: boolean
      tag: string
    } | null
    if (!point) {
      throw new Error(
        action.ref !== undefined
          ? `No element with ref ${action.ref}. The page may have changed, take a new snapshot.`
          : `No element matches selector ${action.selector}`
      )
    }
    return point
  }

  private async clickAt(action: BrowserAction, signal?: AbortSignal): Promise<void> {
    let point = await this.locate(action)
    await this.moveCursor({ x: point.x, y: point.y }, signal)
    // Hover handlers or a layout update can move the target during the cursor animation.
    point = await this.locate(action)
    this.cursorPosition = { x: point.x, y: point.y }
    await this.updateCursor({ action: 'click', ...this.cursorPosition })
    await sleep(60, signal)
    if (point.hit) {
      await this.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
      await this.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await this.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    } else {
      // Something overlaps the element, fall back to a synthetic click.
      const find =
        action.ref !== undefined
          ? `document.querySelector('[data-gx-ref="${Number(action.ref)}"]')`
          : `document.querySelector(${JSON.stringify(action.selector)})`
      await this.wc.executeJavaScript(`(() => { const el = ${find}; if (el) { el.focus?.(); el.click(); } })()`, true)
    }
  }

  private async drag(action: BrowserAction, signal?: AbortSignal): Promise<void> {
    if (action.toX === undefined || action.toY === undefined) throw new Error('`drag` needs `x`, `y`, `toX` and `toY`')
    const from = await this.pagePoint(action.x, action.y)
    const to = await this.pagePoint(action.toX, action.toY)
    await this.moveCursor(from, signal)
    await this.updateCursor({ action: 'click', ...from })
    await this.command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from })
    await this.command('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', buttons: 1, clickCount: 1 })
    let last = from
    try {
      const duration = await this.updateCursor({ action: 'move', ...to })
      const moves = 12
      for (let move = 1; move <= moves; move++) {
        last = { x: from.x + ((to.x - from.x) * move) / moves, y: from.y + ((to.y - from.y) * move) / moves }
        await this.command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...last, button: 'left', buttons: 1 })
        await sleep(Math.max(16, duration / moves), signal)
      }
    } finally {
      // A stopped drag must not leave the page holding the button down.
      await this.command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...last, button: 'left', buttons: 0, clickCount: 1 })
      this.cursorPosition = last
    }
  }

  private async pressKey(key: string): Promise<void> {
    const parts = key.split('+').map((p) => p.trim())
    const raw = parts.pop() ?? ''
    const aliases: Record<string, string> = { Return: 'Enter', Esc: 'Escape', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Space: ' ' }
    const keyCode = aliases[raw] ?? raw
    const masks: Record<string, number> = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 }
    const modifiers = parts.reduce((mask, modifier) => mask | (masks[modifier.toLowerCase()] ?? 0), 0)
    const virtualKeys: Record<string, number> = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 }
    const virtualKey = virtualKeys[keyCode] ?? (/^F\d{1,2}$/.test(keyCode) ? 111 + Number(keyCode.slice(1)) : keyCode.length === 1 ? keyCode.toUpperCase().charCodeAt(0) : undefined)
    const text = !(modifiers & (1 | 2 | 4)) ? keyCode === 'Enter' ? '\r' : keyCode.length === 1 ? keyCode : undefined : undefined
    const params = { key: keyCode, modifiers, windowsVirtualKeyCode: virtualKey }
    await this.command('Input.dispatchKeyEvent', { ...params, type: text ? 'keyDown' : 'rawKeyDown', ...(text ? { text, unmodifiedText: text } : {}) })
    await this.command('Input.dispatchKeyEvent', { ...params, type: 'keyUp' })
  }

  private async capture(): Promise<{ mime: string; base64: string }> {
    const view = this.ensureView()
    let image = await view.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    if (image.getSize().width > SCREENSHOT_WIDTH) image = image.resize({ width: SCREENSHOT_WIDTH, quality: 'good' })
    const jpeg = image.toJPEG(72)
    if (jpeg.length === 0) throw new Error('The page has not painted yet')
    const size = image.getSize()
    const page = (await view.webContents.executeJavaScript('({ width: innerWidth, height: innerHeight })', true)) as { width: number; height: number }
    this.shot = { x: size.width / page.width, y: size.height / page.height, width: size.width, height: size.height }
    return { mime: 'image/jpeg', base64: jpeg.toString('base64') }
  }

  async act(action: BrowserAction, signal?: AbortSignal): Promise<BrowserResult> {
    const result = await this.run(action, signal)
    // Dialogs that opened while the step ran are reported with its result.
    const dialogs = this.dialogLog.splice(0)
    return dialogs.length ? { ...result, text: `${result.text}\n\nBrowser dialogs:\n${dialogs.join('\n')}` } : result
  }

  private async run(action: BrowserAction, signal?: AbortSignal): Promise<BrowserResult> {
    this.ensureView()
    this.setAgentActive(true)
    const wc = this.wc

    switch (action.action) {
      case 'navigate': {
        if (!action.url) throw new Error('`url` is required')
        await this.navigate(action.url, true)
        await this.settle(signal)
        const failure = this.failure
        const prefix = failure ? `The page failed to load: ${failure.name} (${failure.code}) for ${failure.url}. The browser shows an error page with a Try again button.\n\n` : ''
        return { text: `${prefix}${await this.describe(true)}` }
      }
      case 'snapshot':
        return { text: await this.describe(action.full_text !== false) }
      case 'click': {
        await this.clickAt(action, signal)
        await this.settle(signal, 8000)
        return { text: `Clicked.\n\n${await this.describe(false)}` }
      }
      case 'drag': {
        await this.drag(action, signal)
        await this.settle(signal, 8000)
        return { text: `Dragged.\n\n${await this.describe(false)}` }
      }
      case 'type': {
        if (action.text === undefined) throw new Error('`text` is required')
        if (action.ref !== undefined || action.selector || hasPoint(action)) {
          await this.clickAt(action, signal)
          await sleep(80, signal)
        }
        if (action.clear) {
          await wc.executeJavaScript(
            `(() => { const el = document.activeElement; if (!el) return; if ('value' in el) { el.select?.(); } else { document.execCommand('selectAll'); } })()`,
            true
          )
          await this.pressKey('Backspace')
        }
        await this.command('Input.insertText', { text: action.text })
        if (action.submit) {
          await sleep(60, signal)
          await this.pressKey('Enter')
          await this.settle(signal, 8000)
        }
        return { text: `Typed ${JSON.stringify(action.text.length > 80 ? action.text.slice(0, 80) + '…' : action.text)}${action.submit ? ' and pressed Enter' : ''}.\n\n${await this.describe(false)}` }
      }
      case 'press': {
        if (!action.key) throw new Error('`key` is required, for example "Enter" or "Meta+A"')
        await this.pressKey(action.key)
        await this.settle(signal, 5000)
        return { text: `Pressed ${action.key}.` }
      }
      case 'scroll': {
        const amount = Math.max(1, Math.min(20, action.amount ?? 3)) * 240
        const dx = action.direction === 'left' ? -amount : action.direction === 'right' ? amount : 0
        const dy = action.direction === 'up' ? -amount : action.direction === 'down' || !action.direction ? amount : 0
        // A point wheels whatever is under it, such as a scrollable panel, rather than the window.
        if (hasPoint(action)) await this.command('Input.dispatchMouseEvent', { type: 'mouseWheel', ...(await this.pagePoint(action.x, action.y)), deltaX: dx, deltaY: dy })
        else await wc.executeJavaScript(`window.scrollBy({ left: ${dx}, top: ${dy}, behavior: 'instant' })`, true)
        await sleep(200, signal)
        return { text: await this.describe(false) }
      }
      case 'screenshot': {
        const image = await this.capture()
        return { text: `Screenshot of ${wc.getURL()}, ${this.shot?.width}x${this.shot?.height} pixels. Use x and y in these pixels.`, image }
      }
      case 'evaluate': {
        if (!action.script) throw new Error('`script` is required')
        const value = await wc.executeJavaScript(
          `(async () => { const __r = await (async () => { ${/\breturn\b/.test(action.script) ? action.script : `return (${action.script.replace(/;\s*$/, '')})`} })(); try { return JSON.stringify(__r, null, 2) ?? String(__r); } catch { return String(__r); } })()`,
          true
        )
        return { text: truncateEnd(String(value), 20000) }
      }
      case 'back':
        this.back()
        await this.settle(signal)
        return { text: await this.describe(false) }
      case 'forward':
        this.forward()
        await this.settle(signal)
        return { text: await this.describe(false) }
      case 'reload':
        this.reload()
        await this.settle(signal)
        return { text: await this.describe(false) }
      case 'wait': {
        if (action.selector) {
          const deadline = Date.now() + Math.min(30, action.seconds ?? 10) * 1000
          while (Date.now() < deadline) {
            const found = await wc.executeJavaScript(`!!document.querySelector(${JSON.stringify(action.selector)})`, true)
            if (found) return { text: `Found ${action.selector}.` }
            await sleep(200, signal)
          }
          throw new Error(`Timed out waiting for ${action.selector}`)
        }
        await sleep(Math.min(30, Math.max(0.1, action.seconds ?? 1)) * 1000, signal)
        return { text: 'Done waiting.' }
      }
      case 'dialog': {
        this.dialogReply = { accept: action.accept !== false, ...(action.text !== undefined ? { text: action.text } : {}) }
        return { text: `The next dialog will be ${action.accept === false ? 'dismissed' : 'accepted'}${action.text !== undefined ? ` with ${JSON.stringify(action.text)}` : ''}.` }
      }
      case 'console':
        return { text: this.consoleLog.length ? this.consoleLog.slice(-60).join('\n') : 'No console messages.' }
      default:
        throw new Error(`Unknown browser action: ${String((action as BrowserAction).action)}`)
    }
  }
}

class BrowserTabs {
  private windows = new Map<number, BrowserWindow>()
  private tabs = new Map<string, BrowserService>()
  private tabWindows = new Map<string, number>()
  private active = new Map<number, string>()
  private order = new Map<number, string[]>()
  private titles: Record<string, string> = {}
  private agentOwners = new Map<string, Set<string>>()
  private listeners = new Set<(state: BrowserState, tabId: string) => void>()
  windowForChat: (chatId: string) => BrowserWindow | null = () => null
  registerTab: (chatId: string, tabId: string, background: boolean) => void = () => {}
  requestNewTab: (tabId: string) => void = () => {}

  attach(window: BrowserWindow): void {
    this.windows.set(window.id, window)
    window.on('closed', () => {
      for (const [id, windowId] of this.tabWindows) if (windowId === window.id) this.close(id)
      this.windows.delete(window.id)
      this.active.delete(window.id)
      this.order.delete(window.id)
    })
  }
  private windowFor(id?: string, preferred?: BrowserWindow): BrowserWindow {
    const ownerId = id ? this.tabWindows.get(id) : undefined
    if (ownerId !== undefined && preferred && ownerId !== preferred.id) throw new Error('This browser tab belongs to another window.')
    const window = (ownerId !== undefined ? this.windows.get(ownerId) : preferred) ?? [...this.windows.values()].find((entry) => !entry.isDestroyed())
    if (!window || window.isDestroyed()) throw new Error('The app window is not available')
    return window
  }
  windowIdForTab(id: string): number | undefined { return this.tabWindows.get(id) }
  private get(id?: string, preferred?: BrowserWindow): BrowserService {
    const window = this.windowFor(id, preferred)
    const tabId = id ?? this.active.get(window.id) ?? `browser:${window.id}`
    let tab = this.tabs.get(tabId)
    if (!tab) {
      tab = new BrowserService()
      this.tabWindows.set(tabId, window.id)
      tab.attach(window)
      tab.requestNewTab = (url, openedByAgent) => {
        if (window.isDestroyed()) return
        const newTabId = this.create(window)
        if (openedByAgent) {
          this.agentOwners.set(newTabId, new Set(this.agentOwners.get(tabId) ?? []))
          this.get(newTabId, window).setAgentActive(true)
        }
        this.requestNewTab(newTabId)
        void this.get(newTabId, window).navigate(url, openedByAgent).catch(() => {})
      }
      tab.onState((state) => { for (const listener of this.listeners) listener(state, tabId) })
      this.tabs.set(tabId, tab)
    }
    return tab
  }
  create(window?: BrowserWindow): string { const id = newId('browser_'); this.get(id, window); return id }
  close(id: string, window?: BrowserWindow): void {
    if (window && this.tabWindows.has(id)) this.windowFor(id, window)
    this.tabs.get(id)?.close()
    this.tabs.delete(id)
    const ownerId = this.tabWindows.get(id)
    this.tabWindows.delete(id)
    this.agentOwners.delete(id)
    if (ownerId !== undefined) {
      this.order.set(ownerId, (this.order.get(ownerId) ?? []).filter((entry) => entry !== id))
      if (this.active.get(ownerId) === id) this.active.delete(ownerId)
    }
    delete this.titles[id]
  }
  finishRun(chatId: string): void {
    for (const [id, owners] of this.agentOwners) {
      owners.delete(chatId)
      if (owners.size === 0) {
        this.agentOwners.delete(id)
        this.tabs.get(id)?.setAgentActive(false)
      }
    }
  }
  setTabOrder(ids: string[], titles: Record<string, string> = {}, preferred?: BrowserWindow): void {
    const window = this.windowFor(undefined, preferred)
    const ordered = [...new Set(ids)].filter((id) => this.tabWindows.get(id) === window.id && !id.startsWith('preview:'))
    this.order.set(window.id, ordered)
    for (const id of ordered) {
      if (titles[id]) this.titles[id] = titles[id]
      else delete this.titles[id]
    }
  }
  private tabIds(window: BrowserWindow): string[] {
    const ids = [...this.tabs.keys()].filter((id) => this.tabWindows.get(id) === window.id && !id.startsWith('preview:'))
    const order = this.order.get(window.id) ?? []
    return [...order.filter((id) => ids.includes(id)), ...ids.filter((id) => !order.includes(id))]
  }
  /** The tab the user has open, or the newest tab when no browser tab is showing. */
  private currentTab(window: BrowserWindow): string {
    const ids = this.tabIds(window)
    const active = this.active.get(window.id)
    const id = active && ids.includes(active) ? active : ids.at(-1)
    if (!id) throw new Error('No open browser tabs. Use Browser with action "create" and the requested url to open one.')
    return id
  }
  listTabs(window?: BrowserWindow): (BrowserState & { tabIndex: number; tabId: string; visible: boolean })[] {
    if (this.windows.size === 0) return []
    return this.tabIds(this.windowFor(undefined, window)).map((tabId, index) => {
      const tab = this.tabs.get(tabId)!
      const state = tab.state()
      return { ...state, title: this.titles[tabId] || state.title || state.url || 'New tab', tabIndex: index + 1, tabId, visible: tab.isVisible() }
    })
  }
  listTabsForChat(chatId: string): ReturnType<BrowserTabs['listTabs']> { return this.listTabs(this.windowForChat(chatId) ?? undefined) }
  onState(listener: (state: BrowserState, tabId: string) => void): void { this.listeners.add(listener) }
  setBounds(rect: Rect | null, id?: string, preferred?: BrowserWindow): void {
    const window = this.windowFor(id, preferred)
    const tabId = id ?? this.active.get(window.id) ?? `browser:${window.id}`
    if (rect) {
      for (const [otherId, tab] of this.tabs) if (otherId !== tabId && this.tabWindows.get(otherId) === window.id) tab.setBounds(null)
      this.active.set(window.id, tabId)
      this.get(tabId, window).setBounds(rect)
    } else this.tabs.get(tabId)?.setBounds(null)
  }
  frame(id?: string, window?: BrowserWindow): Promise<string | null> {
    return this.get(id, window).frame()
  }

  state(id?: string, window?: BrowserWindow): BrowserState {
    if (id) return this.get(id, window).state()
    const owner = this.windowFor(undefined, window)
    const activeId = this.active.get(owner.id)
    const tab = activeId ? this.tabs.get(activeId) : undefined
    // Reading initial state should not insert an invisible tab into ListTabs.
    return tab?.state() ?? { url: '', title: '', favicon: '', loading: false, canGoBack: false, canGoForward: false, agentActive: false }
  }
  navigate(url: string, id?: string, window?: BrowserWindow): Promise<void> { return this.get(id, window).navigate(url) }
  back(id?: string, window?: BrowserWindow): void { this.get(id, window).back() }
  forward(id?: string, window?: BrowserWindow): void { this.get(id, window).forward() }
  reload(id?: string, window?: BrowserWindow): void { this.get(id, window).reload() }
  stop(id?: string, window?: BrowserWindow): void { this.get(id, window).stop() }
  async clearData(kind: BrowserDataKind): Promise<void> {
    const data = session.fromPartition(PARTITION)
    if (kind === 'cache') await data.clearCache()
    else await data.clearStorageData()
  }
  async act(chatId: string, action: BrowserAction, signal?: AbortSignal): Promise<BrowserResult> {
    if (action.action === 'create') {
      action = { ...action, action: 'navigate', url: action.url || 'about:blank', tabIndex: undefined, background: action.background ?? false }
    }
    const window = this.windowFor(undefined, this.windowForChat(chatId) ?? undefined)
    if (action.action === 'tabs') {
      const tabs = this.listTabs(window).map(({ title, url, tabIndex }) => ({ tabIndex, title, url }))
      return { text: tabs.length ? JSON.stringify(tabs) : 'No open browser tabs. Call Browser with action "create" and the requested url to open one now. Use background:false to show it to the user.' }
    }
    if (action.action === 'navigate' && !action.url) throw new Error('url is required for navigate.')
    if (action.background !== undefined && typeof action.background !== 'boolean') throw new Error('background must be true or false.')
    let id: string
    if (action.tabIndex !== undefined) {
      if (!Number.isInteger(action.tabIndex) || action.tabIndex < 1) throw new Error('tabIndex must be a positive integer (1-based).')
      const selected = this.tabIds(window)[action.tabIndex - 1]
      if (!selected) {
        if (action.action === 'navigate' && this.tabIds(window).length === 0) id = this.create(window)
        else throw new Error(`No browser tab at index ${action.tabIndex}. Use Browser with action "create" and a url to open a new tab, or ListTabs to find an existing tab.`)
      } else id = selected
    } else {
      // Closing is the one action not worth guessing at: it would take the tab the user is on.
      if (action.action === 'close') throw new Error('tabIndex is required to close a tab. Use ListTabs to find it.')
      id = action.action === 'navigate' ? this.create(window) : this.currentTab(window)
    }
    if (action.action === 'close') {
      this.close(id, window)
      return { tabId: id, text: `Closed browser tab ${action.tabIndex}.` }
    }
    const tab = this.get(id, window)
    const owners = this.agentOwners.get(id) ?? new Set<string>()
    owners.add(chatId)
    this.agentOwners.set(id, owners)
    const background = action.action !== 'navigate' || action.background !== false
    this.registerTab(chatId, id, background)
    const result = await tab.act(action, signal)
    const tabIndex = this.tabIds(window).indexOf(id) + 1
    return { ...result, tabId: id, tabIndex, url: tab.state().url, text: `Tab index: ${tabIndex}\n${action.action === 'navigate' ? `Background: ${background}\n` : ''}${result.text}` }
  }
}

export const browser = new BrowserTabs()
