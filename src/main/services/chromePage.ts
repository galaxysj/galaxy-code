import { nativeImage } from 'electron'
import { setTimeout as delay } from 'node:timers/promises'
import { Script } from 'node:vm'
import { truncateEnd } from '../util'
import type { BrowserAction, BrowserResult } from './browser'
import { formatPageSnapshot, keyEvent, locateScript, SNAPSHOT_SCRIPT, type PageSnapshot } from './browserPage'
import type { CdpParameters, ChromeCdp } from './chromeCdp'

interface Point { x: number; y: number }
interface Size { width: number; height: number }
interface Frame { id: string; parentId?: string }
interface Evaluation<T> {
  result: { value?: T; description?: string }
  exceptionDetails?: { text: string; exception?: { description?: string } }
}

function canControlAddress(url: string): boolean {
  return /^(?:https?:\/\/|file:\/\/|about:blank(?:[#?]|$))/i.test(url)
}

export function chromePageUrl(url: string): boolean {
  return url === '' || canControlAddress(url)
}

const DIALOG_ACTIONS = new Set<BrowserAction['action']>(['navigate', 'click', 'drag', 'type', 'press', 'evaluate', 'back', 'forward', 'reload'])

/** Parse locally so evaluating an expression with a nested return never runs it twice. */
function evaluationSource(source: string): string {
  const expression = `(async () => (${source.trim().replace(/;$/, '')}\n))()`
  try {
    new Script(expression)
    return expression
  } catch {
    return `(async () => { ${source}\n })()`
  }
}

export class ChromePage {
  private mainFrame = ''
  private loading = false
  private shot: (Size & { viewport: Size }) | null = null
  private answerDialogs = false
  private dialogReply: { accept: boolean; text?: string } | null = null
  private readonly dialogs: string[] = []
  private readonly consoleLog: string[] = []

  constructor(private readonly connection: ChromeCdp, readonly sessionId: string) {}

  async initialize(): Promise<void> {
    await this.send('Page.enable')
    const { frameTree } = await this.send<{ frameTree: { frame: Frame } }>('Page.getFrameTree')
    this.mainFrame = frameTree.frame.id
    await Promise.all([this.send('Runtime.enable'), this.send('Log.enable')])
  }

  event(method: string, params: CdpParameters): void {
    if (method === 'Page.frameStartedLoading' && params.frameId === this.mainFrame) this.loading = true
    if (method === 'Page.frameStoppedLoading' && params.frameId === this.mainFrame) this.loading = false
    if (method === 'Page.frameNavigated') {
      const frame = params.frame as Frame
      if (!frame.parentId) {
        this.mainFrame = frame.id
        this.shot = null
      }
    }
    if (method === 'Page.javascriptDialogOpening' && this.answerDialogs) {
      const reply = this.dialogReply
      this.dialogReply = null
      const accept = reply?.accept ?? params.type === 'alert'
      this.dialogs.push(truncateEnd(`${String(params.type)}: ${String(params.message)} (${accept ? 'accepted' : 'dismissed'})`, 500))
      void this.send('Page.handleJavaScriptDialog', { accept, promptText: reply?.text }).catch(() => {})
    }
    if (method === 'Runtime.consoleAPICalled') {
      const args = params.args as Array<{ value?: unknown; description?: string; type: string }>
      this.log(`${String(params.type)}: ${args.map((arg) => arg.value === undefined ? arg.description ?? arg.type : String(arg.value)).join(' ')}`)
    }
    if (method === 'Runtime.exceptionThrown') {
      const detail = params.exceptionDetails as NonNullable<Evaluation<unknown>['exceptionDetails']>
      this.log(detail.exception?.description ?? detail.text)
    }
    if (method === 'Log.entryAdded') {
      const entry = params.entry as { level: string; text: string }
      this.log(`${entry.level}: ${entry.text}`)
    }
  }

  private log(message: string): void {
    this.consoleLog.push(truncateEnd(message, 1000))
    if (this.consoleLog.length > 60) this.consoleLog.shift()
  }

  private send<T = void>(method: string, params?: CdpParameters, signal?: AbortSignal, timeout?: number): Promise<T> {
    return this.connection.send(method, params, this.sessionId, signal, timeout)
  }

  private async evaluate<T>(expression: string, signal?: AbortSignal): Promise<T> {
    const guarded = `(() => {
      if (!(${canControlAddress.toString()})(location.href)) throw new Error('This Chrome page is outside browser control.');
      return (${expression});
    })()`
    const response = await this.send<Evaluation<T>>('Runtime.evaluate', { expression: guarded, awaitPromise: true, returnByValue: true }, signal)
    const error = response.exceptionDetails
    if (error) throw new Error(error.exception?.description ?? error.text)
    return response.result.value as T
  }

  private async settle(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + 10000
    await delay(160, undefined, { signal })
    while (this.loading && Date.now() < deadline) await delay(100, undefined, { signal })
  }

  private async describe(includeText: boolean, signal?: AbortSignal): Promise<string> {
    return formatPageSnapshot(await this.evaluate<PageSnapshot>(SNAPSHOT_SCRIPT, signal), includeText)
  }

  private viewport(signal?: AbortSignal): Promise<Size> {
    return this.evaluate('({ width: innerWidth, height: innerHeight })', signal)
  }

  private async point(x: number | undefined, y: number | undefined, signal?: AbortSignal): Promise<Point> {
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Provide both x and y.')
    const shot = this.shot
    if (!shot) throw new Error('Take a screenshot of this Chrome tab before using coordinates.')
    const viewport = await this.viewport(signal)
    if (viewport.width !== shot.viewport.width || viewport.height !== shot.viewport.height) throw new Error('The Chrome viewport changed. Take a new screenshot.')
    if (x < 0 || y < 0 || x >= shot.width || y >= shot.height) throw new Error(`Point (${x}, ${y}) is outside the ${shot.width}x${shot.height} screenshot.`)
    return { x: x * viewport.width / shot.width, y: y * viewport.height / shot.height }
  }

  private mouse(type: string, point: Point, params: CdpParameters, signal?: AbortSignal, timeout?: number): Promise<void> {
    return this.send('Input.dispatchMouseEvent', { type, ...point, ...params }, signal, timeout)
  }

  private async click(action: BrowserAction, signal?: AbortSignal): Promise<void> {
    let point: Point
    if (action.x !== undefined || action.y !== undefined) point = await this.point(action.x, action.y, signal)
    else {
      if (action.ref === undefined && !action.selector) throw new Error('Provide a ref from a snapshot, a CSS selector, or screenshot coordinates.')
      const element = await this.evaluate<(Point & { hit: boolean }) | null>(locateScript(action), signal)
      if (!element?.hit) throw new Error('The element is missing or covered. Take a new snapshot or screenshot.')
      point = { x: element.x, y: element.y }
    }
    await this.mouse('mouseMoved', { x: point.x, y: point.y }, {}, signal)
    const button = { button: 'left', clickCount: 1 }
    signal?.throwIfAborted()
    try {
      await this.mouse('mousePressed', point, { ...button, buttons: 1 }, signal)
    } finally {
      // The press may already have reached Chrome when cancellation interrupts the reply.
      await this.mouse('mouseReleased', point, { ...button, buttons: 0 }, undefined, 1500).catch(() => {})
    }
    signal?.throwIfAborted()
  }

  private async drag(action: BrowserAction, signal?: AbortSignal): Promise<void> {
    const from = await this.point(action.x, action.y, signal)
    const to = await this.point(action.toX, action.toY, signal)
    await this.mouse('mouseMoved', from, {}, signal)
    const button = { button: 'left', clickCount: 1 }
    let last = from
    signal?.throwIfAborted()
    try {
      await this.mouse('mousePressed', from, { ...button, buttons: 1 }, signal)
      for (let step = 1; step <= 12; step++) {
        last = { x: from.x + (to.x - from.x) * step / 12, y: from.y + (to.y - from.y) * step / 12 }
        await this.mouse('mouseMoved', last, { button: 'left', buttons: 1 }, signal)
        await delay(16, undefined, { signal })
      }
    } finally {
      await this.mouse('mouseReleased', last, { ...button, buttons: 0 }, undefined, 1500).catch(() => {})
    }
    signal?.throwIfAborted()
  }

  private async press(key: string, signal?: AbortSignal): Promise<void> {
    const { params, text } = keyEvent(key)
    signal?.throwIfAborted()
    try {
      await this.send('Input.dispatchKeyEvent', { ...params, type: text ? 'keyDown' : 'rawKeyDown', ...(text ? { text, unmodifiedText: text } : {}) }, signal)
    } finally {
      await this.send('Input.dispatchKeyEvent', { ...params, type: 'keyUp' }, undefined, 1500).catch(() => {})
    }
    signal?.throwIfAborted()
  }

  private async navigate(url: string, background: boolean, signal?: AbortSignal): Promise<void> {
    if (!background) await this.send('Page.bringToFront', undefined, signal)
    const result = await this.send<{ errorText?: string; isDownload?: boolean }>('Page.navigate', { url }, signal)
    if (result.errorText) throw new Error(`Chrome could not load ${url}: ${result.errorText}`)
    if (result.isDownload) throw new Error('Chrome started a download instead of opening a page.')
  }

  async act(action: BrowserAction, signal?: AbortSignal): Promise<BrowserResult> {
    this.answerDialogs = DIALOG_ACTIONS.has(action.action)
    try {
      const result = await this.run(action, signal)
      const dialogs = this.dialogs.splice(0)
      return dialogs.length ? { ...result, text: `${result.text}\n\nBrowser dialogs:\n${dialogs.join('\n')}` } : result
    } finally {
      this.answerDialogs = false
    }
  }

  private async run(action: BrowserAction, signal?: AbortSignal): Promise<BrowserResult> {
    switch (action.action) {
      case 'navigate':
        await this.navigate(action.url!, action.background !== false, signal)
        await this.settle(signal)
        return { text: await this.describe(true, signal) }
      case 'snapshot':
        return { text: await this.describe(action.full_text !== false, signal) }
      case 'click':
      case 'drag':
        if (action.action === 'click') await this.click(action, signal)
        else await this.drag(action, signal)
        await this.settle(signal)
        return { text: await this.describe(false, signal) }
      case 'type':
        if (typeof action.text !== 'string') throw new Error('text is required.')
        if (action.ref !== undefined || action.selector || action.x !== undefined || action.y !== undefined) await this.click(action, signal)
        if (action.clear) {
          await this.evaluate(`(() => {
            const el = document.activeElement;
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
            else if (el?.isContentEditable) document.execCommand('selectAll');
            else throw new Error('Focus an editable field before clearing it.');
          })()`, signal)
          await this.press('Backspace', signal)
        }
        await this.send('Input.insertText', { text: action.text }, signal)
        if (action.submit) await this.press('Enter', signal)
        await this.settle(signal)
        return { text: `Typed ${action.text.length} characters${action.submit ? ' and pressed Enter' : ''}.\n\n${await this.describe(false, signal)}` }
      case 'press':
        if (!action.key) throw new Error('key is required, for example Enter or Meta+A.')
        await this.press(action.key, signal)
        await this.settle(signal)
        return { text: `Pressed ${action.key}.` }
      case 'scroll': {
        const amount = Math.max(1, Math.min(20, Number(action.amount) || 3)) * 240
        const deltaX = action.direction === 'left' ? -amount : action.direction === 'right' ? amount : 0
        const deltaY = deltaX ? 0 : action.direction === 'up' ? -amount : amount
        if (action.x !== undefined || action.y !== undefined) {
          const at = await this.point(action.x, action.y, signal)
          await this.mouse('mouseWheel', at, { deltaX, deltaY }, signal)
        } else await this.evaluate(`window.scrollBy({ left: ${deltaX}, top: ${deltaY}, behavior: 'instant' })`, signal)
        await delay(180, undefined, { signal })
        return { text: await this.describe(false, signal) }
      }
      case 'screenshot': {
        const viewport = await this.viewport(signal)
        const { data } = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 82, captureBeyondViewport: false }, signal)
        const size = nativeImage.createFromBuffer(Buffer.from(data, 'base64')).getSize()
        if (!size.width || !size.height) throw new Error('Chrome returned an empty screenshot.')
        this.shot = { ...size, viewport }
        return { text: `Chrome screenshot, ${size.width}x${size.height} pixels. Use x and y in these pixels.`, image: { mime: 'image/jpeg', base64: data } }
      }
      case 'evaluate': {
        if (!action.script) throw new Error('script is required.')
        const value = await this.evaluate(evaluationSource(action.script), signal)
        return { text: truncateEnd(typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'undefined', 20000) }
      }
      case 'back':
      case 'forward': {
        const history = await this.send<{ currentIndex: number; entries: { id: number; url: string }[] }>('Page.getNavigationHistory', undefined, signal)
        const entry = history.entries[history.currentIndex + (action.action === 'back' ? -1 : 1)]
        if (!entry) throw new Error(`There is no Chrome history entry to go ${action.action} to.`)
        if (!chromePageUrl(entry.url)) throw new Error('The Chrome history entry is outside browser control.')
        await this.send('Page.navigateToHistoryEntry', { entryId: entry.id }, signal)
        await this.settle(signal)
        return { text: await this.describe(false, signal) }
      }
      case 'reload':
        await this.send('Page.reload', undefined, signal)
        await this.settle(signal)
        return { text: await this.describe(false, signal) }
      case 'wait': {
        const duration = Math.max(0.1, Math.min(30, Number(action.seconds) || (action.selector ? 10 : 1))) * 1000
        if (!action.selector) {
          await delay(duration, undefined, { signal })
          return { text: 'Done waiting.' }
        }
        const until = Date.now() + duration
        do {
          if (await this.evaluate(`!!document.querySelector(${JSON.stringify(action.selector)})`, signal)) return { text: `Found ${action.selector}.` }
          await delay(180, undefined, { signal })
        } while (Date.now() < until)
        throw new Error(`Timed out waiting for ${action.selector}.`)
      }
      case 'console':
        return { text: this.consoleLog.join('\n') || 'No console messages.' }
      case 'dialog':
        this.dialogReply = { accept: action.accept !== false, text: action.text }
        return { text: `The next Chrome dialog will be ${this.dialogReply.accept ? 'accepted' : 'dismissed'}.` }
      case 'resize': {
        this.shot = null
        if (action.width == null && action.height == null) {
          await this.send('Emulation.clearDeviceMetricsOverride', undefined, signal)
          return { text: 'Restored the default Chrome viewport.' }
        }
        const viewport = await this.viewport(signal)
        const width = action.width ?? viewport.width
        const height = action.height ?? viewport.height
        if (![width, height].every((value) => Number.isInteger(value) && value >= 1 && value <= 4096)) throw new Error('Chrome viewport dimensions must be integers between 1 and 4096.')
        await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, signal)
        return { text: `Resized the Chrome viewport to ${width}x${height} CSS pixels.` }
      }
      default:
        throw new Error(`Unknown Chrome page action: ${action.action}.`)
    }
  }
}
