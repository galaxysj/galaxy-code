import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, BrowserWindow, desktopCapturer, globalShortcut, nativeImage, screen, shell, systemPreferences, type Rectangle } from 'electron'
import type { ComputerCursor, ComputerPermission, ComputerPermissions, ComputerWindow, InstalledApp } from '@shared/types'
import { store } from '../store'
import { errorMessage, newId, sleep, truncateEnd } from '../util'
import { agentCursorScript } from './browserCursor'

const run = promisify(execFile)

export interface ComputerAction {
  action: 'apps' | 'open_app' | 'activate' | 'tree' | 'screenshot' | 'snapshot' | 'click' | 'move' | 'drag' | 'type' | 'set_value' | 'press' | 'scroll' | 'wait'
  /** tree, screenshot, snapshot, activate and open_app: the app's name. */
  app?: string
  /** tree, screenshot, snapshot and activate: part of the window's title, when the app has several. */
  window?: string
  /** tree only: read the menu bar instead of the window. */
  menu?: boolean
  /** tree only: keep only the elements whose text contains this. */
  query?: string
  /** tree only: the whole tree instead of what changed since the last one. */
  full?: boolean
  /** screenshot only: a part of the latest screenshot to see up close, as x, y, width, height in its pixels. */
  region?: [number, number, number, number]
  /** An element from the latest tree. */
  ref?: string
  /** A point in the pixels of the latest screenshot. */
  x?: number
  y?: number
  /** drag only: where the drag ends, in the same pixels. */
  toX?: number
  toY?: number
  /** drag and move: points to pass through in order, as [x, y] pairs, for lines and shapes. */
  path?: [number, number][]
  /** click and drag: keys held down, such as ["shift"]. */
  modifiers?: string[]
  button?: 'left' | 'right'
  count?: number
  text?: string
  key?: string
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
  seconds?: number
}

export interface ComputerResult {
  text: string
  image?: { mime: string; base64: string }
}

interface AppWindow {
  id: number
  pid: number
  app: string
  title: string
  layer: number
  x: number
  y: number
  width: number
  height: number
}

interface TreeNode {
  ref: string
  role: string
  title: string
  value: string
  actions: string[]
  disabled?: boolean
  focused?: boolean
  frame?: [number, number, number, number]
}

/** The window a chat is working in, what its latest tree showed and the size of its latest screenshot. */
interface Target {
  window: AppWindow
  nodes: Map<string, TreeNode>
  /** The lines of the latest tree of the window and of the menu bar, by ref. */
  lines: { window?: Map<string, string>; menu?: Map<string, string> }
  /** When the agent last acted on the window, until a read has waited for that to show. */
  actedAt?: number
  /** What the window showed at the latest read, until the agent itself acts on it. */
  seen?: string
  /** The agent was told about a change, so a page that never stops changing cannot block it for good. */
  warned?: boolean
  /** `alert` is set when the screenshot shows an alert instead of the window, so its pixels map to the alert. */
  image: { width: number; height: number; windowWidth: number; windowHeight: number; alert: AppWindow | null } | null
}

const SCREENSHOT_WIDTH = 1400

/** How long after an action a read waits at least and at most. Pages and apps show what a click did late, and a page that animates never stops changing. */
const SETTLE_MIN_MS = 1000
const SETTLE_MAX_MS = 3000

/** The pace of the helper's drags, whose small steps take at least this long, and how often the cursor follows them. */
const GESTURE_PIXELS_PER_MS = 6 / 9
const CURSOR_STEP_MS = 40

/** The modal panel level, where macOS puts alerts. */
const ALERT_LAYER = 8

const CANCELED = 'The user pressed Esc and canceled computer use. Do not make any more Computer calls this turn. Stop all computer actions, continue with the rest of the work without them, and tell the user what was left undone.'

/**
 * The glow along the edges of a display, and the notice on the main one. No API reports how round a screen is,
 * so `radius` comes from the display, and `notice` is how far above the bottom edge the notice goes. Four gradients keep square corners square, where a blurred shadow would round them.
 */
function fullControlPage(radius: number, notice: number | null): string {
  const edge = (side: string, size: string): string => `<div style="position:absolute;${side}:0;${size}:70px;background:linear-gradient(to ${side === 'top' ? 'bottom' : side === 'bottom' ? 'top' : side === 'left' ? 'right' : 'left'},rgba(37,139,255,.8),rgba(37,139,255,0))"></div>`
  const across = (side: string): string => edge(side, 'height').replace('position:absolute;', 'position:absolute;left:0;right:0;')
  const down = (side: string): string => edge(side, 'width').replace('position:absolute;', 'position:absolute;top:0;bottom:0;')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;font:600 13px -apple-system,BlinkMacSystemFont,sans-serif}
.glow{position:fixed;inset:0;overflow:hidden;border-radius:${radius}px ${radius}px 0 0;box-shadow:inset 0 0 0 2px rgba(37,139,255,.95);animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{50%{opacity:.6}}
.note{position:fixed;left:50%;bottom:${notice ?? 0}px;transform:translateX(-50%);padding:8px 14px;border-radius:12px;background:rgba(5,5,5,.84);color:#fff;white-space:nowrap}
.note span{margin-left:10px;font-weight:400;font-size:12px;color:rgba(255,255,255,.72)}
@media (prefers-reduced-motion:reduce){.glow{animation:none}}
</style></head><body><div class="glow">${across('top')}${across('bottom')}${down('left')}${down('right')}</div>${notice !== null ? '<div class="note">Galaxy is using your computer<span>Press Esc to cancel</span></div>' : ''}</body></html>`
}

/** Where macOS keeps apps, and the one app people use that lives elsewhere. */
const APP_FOLDERS = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', join(homedir(), 'Applications')]
const FINDER = { name: 'Finder', path: '/System/Library/CoreServices/Finder.app' }
const APP_LIST_MS = 60_000
const APP_RESULTS = 8

/** System prompts for passwords and permissions, which only the user may answer. */
const SYSTEM_PROMPTS = new Set(['SecurityAgent', 'universalAccessAuthWarn', 'coreautha', 'Dock', 'Window Server'])

const PRIVACY_PANES: Record<ComputerPermission, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
}

const FLAGS: Record<string, number> = {
  shift: 0x20000,
  ctrl: 0x40000,
  control: 0x40000,
  alt: 0x80000,
  option: 0x80000,
  cmd: 0x100000,
  command: 0x100000,
  meta: 0x100000
}

/** Virtual key codes of the US layout. */
const KEY_CODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '=': 24, '9': 25, '7': 26, '-': 27, '8': 28, '0': 29,
  ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, l: 37, j: 38, "'": 39, k: 40, ';': 41, '\\': 42, ',': 43, '/': 44,
  n: 45, m: 46, '.': 47, '`': 50,
  enter: 36, return: 36, tab: 48, space: 49, ' ': 49, backspace: 51, delete: 117, escape: 53, esc: 53,
  home: 115, end: 119, pageup: 116, pagedown: 121, left: 123, arrowleft: 123, right: 124, arrowright: 124,
  down: 125, arrowdown: 125, up: 126, arrowup: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111
}

function parseKey(input: string): { code: number; flags: number } {
  const parts = input.split('+').map((part) => part.trim().toLowerCase())
  const name = parts.pop() || (input.includes('+') ? '=' : '')
  const code = KEY_CODES[name]
  if (code === undefined) throw new Error(`Unknown key: ${input}`)
  let flags = 0
  for (const part of parts) {
    if (FLAGS[part] === undefined) throw new Error(`Unknown modifier in ${input}: ${part}`)
    flags |= FLAGS[part]
  }
  return { code, flags }
}

function helperPath(): string {
  return join(app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'), 'resources', 'bin', 'computer-helper')
}

/** Runs one request in the helper, which throws what it reports as an error. */
async function helper<T>(request: Record<string, unknown>): Promise<T> {
  const { stdout } = await run(helperPath(), [JSON.stringify(request)], { timeout: 60_000, maxBuffer: 32_000_000 })
  const reply = JSON.parse(stdout) as T & { error?: string }
  if (reply.error) throw new Error(reply.error)
  return reply
}

async function listWindows(): Promise<AppWindow[]> {
  const { windows } = await helper<{ windows: AppWindow[] }>({ op: 'windows' })
  // The app's own windows hold the approval prompts, so an agent must never be able to reach them.
  return windows.filter((window) => window.width >= 50 && window.height >= 50 && window.pid !== process.pid && !SYSTEM_PROMPTS.has(window.app))
}

function findWindow(windows: AppWindow[], name: string, title?: string): AppWindow {
  const wanted = name.toLowerCase()
  const exact = windows.filter((window) => window.app.toLowerCase() === wanted)
  const matches = (exact.length ? exact : windows.filter((window) => window.app.toLowerCase().includes(wanted)))
    .filter((window) => !title || window.title.toLowerCase().includes(title.toLowerCase()))
    // An app's alerts are read with its window, so the window comes first.
    .sort((a, b) => a.layer - b.layer)
  if (!matches[0]) throw new Error(`No window found for ${name}${title ? ` titled ${title}` : ''}. Use the apps action to list windows, or open_app to open the app.`)
  return matches[0]
}

function nodeLine(node: TreeNode): string {
  const depth = node.ref.split('.').length - 1
  const actions = node.actions.map((action) => action.replace(/^AX/, '')).filter((action) => action !== 'Raise')
  return `${'  '.repeat(depth)}[${node.ref}] ${node.role.replace(/^AX/, '')}${node.title ? ` "${node.title}"` : ''}${node.value ? ` value=${JSON.stringify(node.value)}` : ''}${node.disabled ? ' (disabled)' : ''}${node.focused ? ' (focused)' : ''}${actions.length ? ` {${actions.join(', ')}}` : ''}`
}

/** What changed between two trees, or null when listing it would not be shorter than the tree itself. */
function treeChanges(previous: Map<string, string>, current: Map<string, string>): string | null {
  // Refs are positions, so an element that moved counts as changed: the agent needs its new ref.
  const gone = [...previous].filter(([ref, line]) => current.get(ref) !== line).map(([, line]) => `- ${line.trimStart()}`)
  const added = [...current].filter(([ref, line]) => previous.get(ref) !== line).map(([, line]) => `+ ${line.trimStart()}`)
  if (gone.length + added.length >= current.size) return null
  return gone.length + added.length === 0 ? 'No changes since the last tree. Earlier refs still hold.' : `Changes since the last tree (+ new, - gone). Other refs still hold:\n${[...gone, ...added].join('\n')}`
}

class ComputerService {
  /** Tells the app which window a chat is working in, for the live view. */
  onWindow: (chatId: string, window: ComputerWindow | null) => void = () => {}
  /** The overlay is a window of its own, so a capture of the target misses it and the live view draws the cursor itself. */
  onCursor: (cursor: ComputerCursor) => void = () => {}
  onFrame: (windowId: number, jpeg: Uint8Array) => void = () => {}
  /** The apps found on this computer, and when. */
  private installed: { at: number; apps: InstalledApp[] } | null = null
  /** The App Context shortcut now registered. */
  private contextShortcut: string | null = null
  /** Installed apps' icons as data URLs, by path. */
  private fileIcons = new Map<string, string>()
  /** App icons as data URLs, by process. */
  private icons = new Map<number, string>()
  /** Every window a chat has worked in during its run, which are the ones the live view may show. */
  private visited = new Map<string, Set<number>>()
  /** The helpers streaming the windows of the live view, so that switching between them shows a picture at once. */
  private live = new Map<number, ChildProcess>()
  /** A window of its own that draws the agent cursor. Clicks pass through it. */
  private overlay: Promise<BrowserWindow> | null = null
  /** The window server level the overlay was last given, so it is only set when it changes. */
  private overlayLayer = 0
  /** The window the cursor last sat on. */
  private anchor: AppWindow | null = null
  /** Windows of this app that clicks pass through. Everything else it owns is out of an agent's reach. */
  private clickThrough = new Set<BrowserWindow>()
  private targets = new Map<string, Target>()
  /** The window a chat last worked in, kept while a full control screenshot makes the screen its target, so refs stay valid. */
  private windows = new Map<string, Target>()
  private owners = new Set<string>()
  /** Chats with the whole screen, until their run ends. */
  private fullControl = new Set<string>()
  /** Chats the user stopped with Esc. They can do nothing more on the computer until their run ends. */
  private canceled = new Set<string>()
  private asked = new Set<string>()
  /** Chats in Full Access, whose apps really come to the front instead of acting as if they were there. */
  private inFront = new Set<string>()
  /** The app each chat has told it is active, until its run ends or it moves to another app. */
  private held = new Map<string, Record<string, unknown>>()
  private fullControlWindows: { window: BrowserWindow; bounds: Rectangle }[] = []
  private cursorProcess: ChildProcess | null = null
  private cursorTimer: NodeJS.Timeout | null = null

  /** Chats that should be asked for full control by the default mode, once a run. */
  wantsFullControl(chatId: string): boolean {
    if (store.settings.computerMode !== 'full' || this.fullControl.has(chatId) || this.canceled.has(chatId) || this.asked.has(chatId)) return false
    this.asked.add(chatId)
    return true
  }

  /** Sets whether a chat's apps come to the front, which Full Access asks for. */
  setInFront(chatId: string, inFront: boolean): void {
    if (inFront) this.inFront.add(chatId)
    else this.inFront.delete(chatId)
  }

  /** Throws what the agent must be told once the user has canceled. */
  assertNotCanceled(chatId: string): void {
    if (this.canceled.has(chatId)) throw new Error(CANCELED)
  }

  startFullControl(chatId: string): void {
    this.assertNotCanceled(chatId)
    if (!this.permissions().screen) throw new Error('Galaxy Code needs the Screen Recording permission. Ask the user to grant it in Settings > Computer Use.')
    this.requireAccessibility()
    this.fullControl.add(chatId)
    void this.release(chatId)
    // From here on the agent works on the screen as a whole, not in the window it had.
    this.screenTarget(chatId)
    if (this.fullControlWindows.length) return
    // The real cursor takes over from the drawn one.
    this.closeOverlay()
    const main = screen.getPrimaryDisplay().id
    this.fullControlWindows = screen.getAllDisplays().map(({ bounds, id, internal, workArea }) => {
      // A built-in display tall enough for a notch has rounded top corners. Everything else is square.
      const radius = internal && workArea.y - bounds.y > 28 ? 12 : 0
      const window = new BrowserWindow({
        ...bounds,
        frame: false,
        transparent: true,
        hasShadow: false,
        resizable: false,
        movable: false,
        focusable: false,
        skipTaskbar: true,
        enableLargerThanScreen: true,
        // A frameless window has rounded corners of its own, which would cut the glow on a square display.
        roundedCorners: false,
        hiddenInMissionControl: true,
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true }
      })
      window.setIgnoreMouseEvents(true)
      this.clickThrough.add(window)
      window.setAlwaysOnTop(true, 'screen-saver')
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
      // Agents should see the screen, not the notice on it.
      window.setContentProtection(true)
      void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fullControlPage(radius, id === main ? bounds.y + bounds.height - (workArea.y + workArea.height) + 14 : null))}`).then(() => { if (!window.isDestroyed()) window.showInactive() })
      return { window, bounds }
    })
    this.cursorProcess = spawn(helperPath(), ['hide-cursor'], { stdio: 'ignore' })
    this.cursorProcess.on('error', () => {})
    this.cursorTimer = setInterval(() => this.drawPointer(), 16)
    this.listenForEsc(true)
  }

  /** Draws the Galaxy cursor where the real, hidden one is, on the display it is on. */
  private drawPointer(): void {
    const point = screen.getCursorScreenPoint()
    for (const { window, bounds } of this.fullControlWindows) {
      if (window.isDestroyed()) continue
      const here = point.x >= bounds.x && point.y >= bounds.y && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height
      const update = agentCursorScript(here ? { action: 'show', x: point.x - bounds.x, y: point.y - bounds.y } : { action: 'hide' })
      void window.webContents.executeJavaScript(update).catch(() => {})
    }
  }

  /** Shows a press on the Galaxy cursor of full control. */
  private pressPointer(action: 'click' | 'press' | 'release'): void {
    const point = screen.getCursorScreenPoint()
    for (const { window, bounds } of this.fullControlWindows) {
      if (window.isDestroyed()) continue
      const here = point.x >= bounds.x && point.y >= bounds.y && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height
      // A drag can end on another display, and release has to reach the one it started on.
      if (here || action === 'release') void window.webContents.executeJavaScript(agentCursorScript({ action, x: point.x - bounds.x, y: point.y - bounds.y })).catch(() => {})
    }
  }

  private listenForEsc(on: boolean): void {
    if (on) globalShortcut.register('Escape', () => this.cancelFullControl())
    else globalShortcut.unregister('Escape')
  }

  private endFullControl(): void {
    if (this.cursorTimer) clearInterval(this.cursorTimer)
    this.cursorTimer = null
    for (const { window } of this.fullControlWindows) {
      this.clickThrough.delete(window)
      if (!window.isDestroyed()) window.destroy()
    }
    this.fullControlWindows = []
    this.cursorProcess?.kill()
    this.cursorProcess = null
    this.listenForEsc(false)
  }

  private cancelFullControl(): void {
    for (const chatId of this.fullControl) this.canceled.add(chatId)
    this.fullControl.clear()
    this.endFullControl()
  }

  private requireFullControl(chatId: string, what: string): void {
    if (!this.fullControl.has(chatId)) throw new Error(`${what} needs the real pointer. Add a request_full_control step first, with the reason.`)
  }

  permissions(): ComputerPermissions {
    if (process.platform !== 'darwin') return { accessibility: false, screen: false }
    return { accessibility: systemPreferences.isTrustedAccessibilityClient(false), screen: systemPreferences.getMediaAccessStatus('screen') === 'granted' }
  }

  /** Puts the app in the system's list, which only shows apps that have asked, then opens that list. */
  async requestPermission(kind: ComputerPermission): Promise<void> {
    if (kind === 'accessibility') systemPreferences.isTrustedAccessibilityClient(true)
    else await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => {})
    await shell.openExternal(PRIVACY_PANES[kind])
  }

  private openOverlay(): Promise<BrowserWindow> {
    this.overlay ??= (async () => {
      const window = new BrowserWindow({
        ...screen.getPrimaryDisplay().bounds,
        frame: false,
        transparent: true,
        hasShadow: false,
        resizable: false,
        movable: false,
        focusable: false,
        skipTaskbar: true,
        // Otherwise a window taller than the screen never matches the overlay, which then resizes on every step.
        enableLargerThanScreen: true,
        hiddenInMissionControl: true,
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true }
      })
      window.setIgnoreMouseEvents(true)
      this.clickThrough.add(window)
      await window.loadURL('data:text/html,<!doctype html><html style="background:transparent"></html>')
      window.showInactive()
      return window
    })()
    return this.overlay
  }

  private closeOverlay(): void {
    void this.overlay?.then((window) => {
      this.clickThrough.delete(window)
      if (!window.isDestroyed()) window.destroy()
    }).catch(() => {})
    this.overlay = null
    this.overlayLayer = 0
    this.anchor = null
  }

  /** Puts the cursor back on its window, which a click can bring forward over it. */
  private restackCursor(): void {
    const anchor = this.anchor
    if (!anchor) return
    void this.overlay?.then((window) => { if (!window.isDestroyed()) window.moveAbove(`window:${anchor.id}:0`) }).catch(() => {})
  }

  /** The app's own real windows, by their system window numbers. */
  private ownWindows(): number[] {
    return BrowserWindow.getAllWindows().filter((window) => !this.clickThrough.has(window) && !window.isDestroyed()).map((window) => Number(window.getMediaSourceId().split(':')[1]))
  }

  /** Puts the overlay over one window and right above it, so whatever covers that window covers the cursor too. */
  private async placeOverlay(anchor: AppWindow): Promise<BrowserWindow> {
    const window = await this.openOverlay()
    const frame = { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height }
    const current = window.getBounds()
    if (current.x !== frame.x || current.y !== frame.y || current.width !== frame.width || current.height !== frame.height) window.setBounds(frame)
    if (anchor.layer !== this.overlayLayer) {
      if (anchor.layer > 0) window.setAlwaysOnTop(true, anchor.layer >= 8 ? 'modal-panel' : 'floating')
      else window.setAlwaysOnTop(false)
      this.overlayLayer = anchor.layer
    }
    this.anchor = anchor
    window.moveAbove(`window:${anchor.id}:0`)
    return window
  }

  /** Draws the agent cursor over the window the overlay is on. */
  private async updateCursor(anchor: AppWindow, action: 'move' | 'click' | 'show' | 'press' | 'release', point: { x: number; y: number }): Promise<number> {
    try {
      const window = await this.placeOverlay(anchor)
      const { x, y } = window.getBounds()
      return Number(await window.webContents.executeJavaScript(agentCursorScript({ action, x: point.x - x, y: point.y - y }))) || 0
    } catch {
      // Cursor visuals must not fail the tool.
      return 0
    }
  }

  /** The window of the target's app at a point, which is not the target itself when a dialog is there. */
  private async windowAt(target: Target, point: { x: number; y: number }): Promise<AppWindow> {
    const siblings = (await listWindows()).filter((window) => window.pid === target.window.pid)
    return siblings.find((window) => point.x >= window.x && point.y >= window.y && point.x < window.x + window.width && point.y < window.y + window.height) ?? target.window
  }

  private async pointAt(target: Target, point: { x: number; y: number } | null, signal?: AbortSignal, press = true): Promise<void> {
    if (!point || this.fullControl.size) return
    // A dialog sits in front of the window, so the cursor goes with whichever is at the point.
    const anchor = await this.windowAt(target, point)
    const inside = { x: Math.min(anchor.x + anchor.width - 8, Math.max(anchor.x + 8, point.x)), y: Math.min(anchor.y + anchor.height - 8, Math.max(anchor.y + 8, point.y)) }
    const duration = await this.updateCursor(anchor, 'move', inside)
    const { window } = target
    const shown = { windowId: window.id, x: (inside.x - window.x) / window.width, y: (inside.y - window.y) / window.height }
    this.onCursor({ ...shown, press: null, duration })
    if (duration) await sleep(duration, signal)
    if (!press) return
    await this.updateCursor(anchor, 'click', inside)
    this.onCursor({ ...shown, press: 'click', duration: 0 })
  }

  private requireAccessibility(): void {
    if (!this.permissions().accessibility) throw new Error('Galaxy Code needs the Accessibility permission. Ask the user to grant it in Settings > Computer Use.')
  }

  /** Picks the window a step names, or finds the chat's current one where it is now. */
  private async pick(chatId: string, action: ComputerAction): Promise<Target> {
    const current = this.targets.get(chatId)
    if (!action.app && current?.window.id === 0) return current
    if (!action.app && !current && this.fullControl.has(chatId)) return this.screenTarget(chatId)
    const windows = await listWindows()
    if (action.app) {
      const window = findWindow(windows, action.app, action.window)
      if (current?.window.id === window.id) {
        current.window = window
        return current
      }
      const target: Target = { window, nodes: new Map(), lines: {}, image: null }
      this.targets.set(chatId, target)
      this.visited.set(chatId, (this.visited.get(chatId) ?? new Set()).add(window.id))
      this.onWindow(chatId, { id: window.id, app: window.app, title: window.title, width: window.width, height: window.height })
      if (this.inFront.has(chatId)) await helper(this.request(target, 'bringForward')).catch(() => {})
      return target
    }
    if (!current) throw new Error('Start with a tree or screenshot step that names `app`. It picks the window to work in.')
    const window = windows.find((entry) => entry.id === current.window.id)
    if (!window) throw new Error(`The ${current.window.app} window was closed or minimized. Pass \`app\` to pick a window.`)
    current.window = window
    return current
  }

  /** Full control works on the main display as a whole, as if it were one big window. */
  private screenTarget(chatId: string): Target {
    const { bounds } = screen.getPrimaryDisplay()
    const previous = this.targets.get(chatId)
    if (previous?.window.id) this.windows.set(chatId, previous)
    const target: Target = { window: { id: 0, pid: 0, app: 'Screen', title: '', layer: 0, ...bounds }, nodes: new Map(), lines: {}, image: null }
    this.targets.set(chatId, target)
    this.onWindow(chatId, null)
    return target
  }

  /** An alert the app has open. It blocks the window and is a window of its own, so a screenshot of the window would miss it. */
  private async openAlert(target: Target): Promise<AppWindow | null> {
    if (target.window.layer >= ALERT_LAYER) return null
    return (await listWindows()).find((window) => window.pid === target.window.pid && window.layer >= ALERT_LAYER) ?? null
  }

  /** Remembers what the agent has just read, so a change it did not make can be noticed. */
  private async markRead(target: Target): Promise<void> {
    target.seen = await helper<{ state: string }>(this.request(target, 'state')).then(({ state }) => state, () => undefined)
  }

  /** The target of an action, unless the user changed it since the agent last read it. */
  private async working(chatId: string, action: ComputerAction): Promise<Target> {
    this.requireAccessibility()
    // A ref belongs to a window, even if a screenshot of the whole screen came after the tree.
    const window = action.ref && this.targets.get(chatId)?.window.id === 0 ? this.windows.get(chatId) : undefined
    if (window) this.targets.set(chatId, window)
    const target = await this.pick(chatId, { ...action, app: undefined })
    // Points on a screenshot of an alert mean nothing once it has closed.
    const alert = target.image?.alert
    if (alert && !(await listWindows()).some((entry) => entry.id === alert.id)) target.image = null
    const { seen } = target
    if (seen === undefined) return target
    const { state } = await helper<{ state: string }>(this.request(target, 'state')).catch(() => ({ state: seen }))
    if (state !== seen && !target.warned) {
      target.warned = true
      throw new Error(`${target.window.app} changed since your last read, probably because the user is working in it. Nothing was done. Read it again with tree or screenshot, then decide what to do.`)
    }
    target.warned = false
    return target
  }

  private request(target: Target, op: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
    const { id, pid, x, y, width, height } = target.window
    const whole = id === 0 ? { global: true, blockedWindows: this.ownWindows(), blockedApps: [...SYSTEM_PROMPTS] } : {}
    return { op, windowId: id, pid, x, y, width, height, ...whole, ...fields }
  }

  private async tree(chatId: string, action: ComputerAction, signal?: AbortSignal): Promise<ComputerResult> {
    this.requireAccessibility()
    const target = await this.pick(chatId, action)
    await this.settle(target, signal)
    const { nodes, truncated } = await helper<{ nodes: TreeNode[]; truncated: boolean }>(this.request(target, 'tree', { menu: action.menu === true }))
    const source = action.menu ? 'menu' : 'window'
    const previous = target.lines[source]
    const current = new Map(nodes.map((node) => [node.ref, nodeLine(node)]))
    for (const ref of previous?.keys() ?? []) if (!current.has(ref)) target.nodes.delete(ref)
    for (const node of nodes) target.nodes.set(node.ref, node)
    target.lines[source] = current
    await this.markRead(target)
    const title = target.window.title ? ` "${target.window.title}"` : ''
    const heading = `${action.menu ? 'Menu bar' : 'Window'} of ${target.window.app}${title}:`
    const changes = previous && !action.full && !action.query ? treeChanges(previous, current) : null
    if (changes) return { text: `${heading}\n${truncateEnd(changes, 24000)}` }
    const wanted = action.query?.toLowerCase()
    const lines = nodes.filter((node) => !wanted || `${node.role} ${node.title} ${node.value}`.toLowerCase().includes(wanted)).map((node) => current.get(node.ref)).join('\n')
    const note = nodes.length <= 1 ? '\n\nThis app shows little to accessibility. Use a screenshot and x, y instead.' : truncated ? '\n\nThe tree is cut here.' : ''
    return { text: `${heading}\n${truncateEnd(lines, 24000)}${note}` }
  }

  private async capture(chatId: string, action: ComputerAction, signal?: AbortSignal): Promise<ComputerResult> {
    if (!this.permissions().screen) throw new Error('Galaxy Code needs the Screen Recording permission. Ask the user to grant it in Settings > Computer Use.')
    const current = this.targets.get(chatId)
    const whole = this.fullControl.has(chatId) && !action.app
    const target = whole ? (current?.window.id === 0 ? current : this.screenTarget(chatId)) : await this.pick(chatId, action)
    await this.settle(target, signal)
    const alert = target.window.id ? await this.openAlert(target) : null
    const window = alert ?? target.window
    const dir = join(tmpdir(), 'galaxy-code', 'screenshots')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${newId()}.png`)
    try {
      // Capturing by window id works while other windows cover it.
      await run('screencapture', ['-x', ...(window.id ? ['-o', `-l${window.id}`] : ['-m']), '-t', 'png', file], { timeout: 15_000 })
      let image = nativeImage.createFromBuffer(await readFile(file))
      const scale = target.image && action.region ? image.getSize().width / target.image.width : 0
      if (scale && action.region) {
        // A close look keeps the frame of the last full screenshot, so its coordinates stay valid.
        const [x, y, width, height] = action.region
        const crop = image.crop({ x: Math.round(x * scale), y: Math.round(y * scale), width: Math.round(width * scale), height: Math.round(height * scale) })
        return { text: `Close look at ${width}x${height} pixels of the latest screenshot. Coordinates still refer to the full screenshot.`, image: { mime: 'image/jpeg', base64: crop.toJPEG(82).toString('base64') } }
      }
      if (image.getSize().width > SCREENSHOT_WIDTH) image = image.resize({ width: SCREENSHOT_WIDTH, quality: 'good' })
      const jpeg = image.toJPEG(72)
      if (jpeg.length === 0) throw new Error(`The ${window.app} window could not be captured`)
      const size = image.getSize()
      target.image = { width: size.width, height: size.height, windowWidth: window.width, windowHeight: window.height, alert }
      await this.markRead(target)
      const title = window.title ? ` "${window.title}"` : ''
      if (!window.id) return { text: `Screenshot of the whole main display, ${size.width}x${size.height} pixels. Use x and y in these pixels.`, image: { mime: 'image/jpeg', base64: jpeg.toString('base64') } }
      const scope = alert ? 'The alert blocks the window behind it, so x and y point into the alert until it closes.' : 'Later steps act on this window.'
      return { text: `Screenshot of the ${window.app} ${alert ? 'alert' : 'window'}${title}, ${size.width}x${size.height} pixels. Use x and y in these pixels. ${scope}`, image: { mime: 'image/jpeg', base64: jpeg.toString('base64') } }
    } finally {
      await rm(file, { force: true })
    }
  }

  /** The helper fields that name a step's element, and where it is on screen now. Menus have no place for the cursor. */
  private async locate(target: Target, action: ComputerAction): Promise<{ fields: Record<string, unknown>; point: { x: number; y: number } | null }> {
    const { window } = target
    if (action.ref) {
      const node = target.nodes.get(action.ref)
      if (!node) throw new Error(`Ref ${action.ref} is not in the latest tree. Read the tree first.`)
      const fields = { ref: action.ref, role: node.role, title: node.title }
      if (/^(m|a\d)/.test(action.ref) || /^AXMenu(Bar|BarItem|Item)?$/.test(node.role)) return { fields, point: null }
      // The tree may be old by now, and a stale ref fails here before the cursor moves.
      const { frame } = await helper<{ frame?: [number, number, number, number] }>(this.request(target, 'frame', fields))
      const [x, y, width, height] = frame ?? [window.x, window.y, window.width, window.height]
      return { fields, point: { x: x + width / 2, y: y + height / 2 } }
    }
    if (!target.image) throw new Error('Pass `ref` from a tree, or take a screenshot before using x and y.')
    const point = this.toScreen(target, action.x, action.y)
    return { fields: { pointX: point.x, pointY: point.y }, point }
  }

  /** Converts a point on the latest screenshot to global display points. */
  private toScreen(target: Target, x: number | undefined, y: number | undefined): { x: number; y: number } {
    const { image } = target
    if (!image) throw new Error('Take a screenshot before using x and y.')
    const window = image.alert ?? target.window
    if (image.windowWidth !== window.width || image.windowHeight !== window.height) throw new Error(`The ${window.app} window changed size. Take a new screenshot.`)
    const px = Number(x)
    const py = Number(y)
    if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error('Provide `ref`, or both `x` and `y`')
    if (px < 0 || py < 0 || px >= image.width || py >= image.height) throw new Error(`Point (${px}, ${py}) is outside the ${image.width}x${image.height} screenshot`)
    return { x: window.x + (px * window.width) / image.width, y: window.y + (py * window.height) / image.height }
  }

  /** The points of a drag or move, from `path`, or from x, y to toX, toY. */
  private route(target: Target, action: ComputerAction): { x: number; y: number }[] {
    const raw: [number | undefined, number | undefined][] = action.path?.length ? action.path : action.toX === undefined ? [[action.x, action.y]] : [[action.x, action.y], [action.toX, action.toY]]
    return raw.map(([x, y]) => this.toScreen(target, x, y))
  }

  private pointerFields(action: ComputerAction): Record<string, unknown> {
    let flags = 0
    for (const name of action.modifiers ?? []) {
      if (FLAGS[name.toLowerCase()] === undefined) throw new Error(`Unknown modifier: ${name}`)
      flags |= FLAGS[name.toLowerCase()]
    }
    return { button: action.button === 'right' ? 'right' : 'left', flags }
  }

  /** Runs a gesture with the real pointer, which full control shows as the Galaxy cursor. */
  private async gesture(target: Target, kind: string, points: { x: number; y: number }[], fields: Record<string, unknown>): Promise<ComputerResult> {
    return this.done(target, 'pointer', { ...fields, kind, points: points.map(({ x, y }) => [x, y]) })
  }

  /** Moves the agent cursor along a gesture for as long as it runs, so it drags with it instead of waiting at the start. */
  private async traceCursor(target: Target, anchor: AppWindow, points: { x: number; y: number }[], running: Promise<unknown>): Promise<void> {
    if (this.fullControl.size) return
    const segments = points.slice(1).map((point, index) => ({ from: points[index], to: point, length: Math.hypot(point.x - points[index].x, point.y - points[index].y) }))
    const total = segments.reduce((sum, { length }) => sum + length, 0)
    const { window } = target
    const started = Date.now()
    let finished = false
    const finish = (): void => { finished = true }
    void running.then(finish, finish)
    while (!finished) {
      let left = Math.min(total, (Date.now() - started) * GESTURE_PIXELS_PER_MS)
      const segment = segments.find(({ length }) => {
        if (left <= length) return true
        left -= length
        return false
      }) ?? segments[segments.length - 1]
      if (!segment) return
      const share = segment.length ? left / segment.length : 1
      const point = { x: segment.from.x + (segment.to.x - segment.from.x) * share, y: segment.from.y + (segment.to.y - segment.from.y) * share }
      await this.updateCursor(anchor, 'show', point)
      this.onCursor({ windowId: window.id, x: (point.x - window.x) / window.width, y: (point.y - window.y) / window.height, press: null, duration: CURSOR_STEP_MS })
      await sleep(CURSOR_STEP_MS)
    }
  }

  /** Runs a gesture at points: with full control the real pointer, otherwise posted to the window, which leaves the real pointer alone. */
  private async pointerGesture(chatId: string, target: Target, kind: string, points: { x: number; y: number }[], fields: Record<string, unknown>, signal?: AbortSignal): Promise<ComputerResult> {
    const dragging = kind === 'drag'
    if (this.fullControl.has(chatId)) {
      // The helper does not say when the real pointer arrives, so a drag looks pressed from the start.
      if (dragging) this.pressPointer('press')
      const result = await this.gesture(target, kind, points, fields).finally(() => { if (dragging) this.pressPointer('release') })
      if (kind === 'click') this.pressPointer('click')
      return result
    }
    const hit = await this.windowAt(target, points[0])
    await this.hold(chatId, target, hit)
    await this.pointAt(target, points[0], signal, kind === 'click')
    if (dragging) await this.pressCursor(target, hit, points[0], 'press')
    try {
      const running = this.gesture(target, kind, points, { ...fields, background: true, hit: [hit.id, hit.x, hit.y, hit.width, hit.height] })
      if (kind === 'click') return await running
      await this.traceCursor(target, hit, points, running)
      const result = await running
      // The helper may be ahead of the estimate, so the cursor ends exactly where the gesture did.
      await this.pointAt(target, points[points.length - 1], signal, false)
      return result
    } finally {
      if (dragging) await this.pressCursor(target, hit, points[points.length - 1], 'release')
    }
  }

  /** Shows a drag's button going down or up, on the cursor of the desktop and of the live view. */
  private async pressCursor(target: Target, anchor: AppWindow, point: { x: number; y: number }, action: 'press' | 'release'): Promise<void> {
    if (this.fullControl.size) return
    const { window } = target
    await this.updateCursor(anchor, action, point)
    this.onCursor({ windowId: window.id, x: (point.x - window.x) / window.width, y: (point.y - window.y) / window.height, press: action === 'press' ? 'down' : 'up', duration: 0 })
  }

  /** Screen-wide keys go to whatever has focus. That must not be this app, whose prompts answer to the keyboard. */
  private async keepKeysOffGalaxy(target: Target): Promise<void> {
    if (target.window.id || !BrowserWindow.getFocusedWindow()) return
    const next = (await listWindows()).find((window) => window.layer === 0)
    if (!next) throw new Error('Only Galaxy Code is open, so the keys have nowhere to go.')
    await helper({ op: 'raise', windowId: next.id, pid: next.pid, x: next.x, y: next.y, width: next.width, height: next.height })
  }

  /** Keeps the app acting as if it were in front with the window key, while the real front app stays, until the run ends. The step still runs if that fails, since most input reaches an app behind others. */
  private async hold(chatId: string, target: Target, window: AppWindow | null): Promise<void> {
    if (!target.window.id || this.fullControl.has(chatId)) return
    if (this.inFront.has(chatId)) {
      await helper(this.request(target, 'bringForward')).catch(() => {})
      return
    }
    const { id, x, y, width, height } = window ?? (await this.openAlert(target)) ?? target.window
    if (this.held.get(chatId)?.pid !== target.window.pid) await this.release(chatId)
    const previous = this.held.get(chatId)
    // Another window has to be made key, whatever is in front.
    const sameWindow = (previous?.hit as number[] | undefined)?.[0] === id
    const request = this.request(target, 'focus', { hit: [id, x, y, width, height], front: sameWindow ? previous?.front : undefined })
    this.held.set(chatId, request)
    const reply = await helper<{ front?: number }>(request).catch(() => null)
    this.held.set(chatId, { ...request, front: reply?.front })
  }

  private async release(chatId: string): Promise<void> {
    const request = this.held.get(chatId)
    if (!request) return
    this.held.delete(chatId)
    await helper({ ...request, op: 'unfocus' }).catch(() => {})
  }

  /** Installed apps by name. The list is read again after a while, so a new app shows up without a restart. */
  async searchApps(query: string): Promise<InstalledApp[]> {
    if (process.platform !== 'darwin') return []
    if (!this.installed || Date.now() - this.installed.at > APP_LIST_MS) {
      const found = await Promise.all(APP_FOLDERS.map(async (folder) => (await readdir(folder).catch(() => [] as string[])).filter((name) => name.endsWith('.app')).map((name) => ({ name: name.slice(0, -4), path: join(folder, name) }))))
      this.installed = { at: Date.now(), apps: [FINDER, ...found.flat()] }
    }
    const wanted = query.toLowerCase()
    const matches = this.installed.apps.filter(({ name }) => name.toLowerCase().includes(wanted))
      .sort((a, b) => Number(b.name.toLowerCase().startsWith(wanted)) - Number(a.name.toLowerCase().startsWith(wanted)) || a.name.localeCompare(b.name))
      .slice(0, APP_RESULTS)
    // app.getFileIcon answers with the generic icon for an app bundle, so the helper asks the system.
    const missing = matches.filter(({ path }) => !this.fileIcons.has(path)).map(({ path }) => path)
    if (missing.length) {
      const { icons } = await helper<{ icons: string[] }>({ op: 'fileIcons', paths: missing }).catch(() => ({ icons: [] as string[] }))
      missing.forEach((path, index) => { if (icons[index]) this.fileIcons.set(path, `data:image/png;base64,${icons[index]}`) })
    }
    return matches.map((entry) => ({ ...entry, icon: this.fileIcons.get(entry.path) }))
  }

  /** Sets the global App Context shortcut, or removes it with null. Says whether the system let the app have it. */
  setAppContextShortcut(accelerator: string | null, capture: () => void): boolean {
    if (this.contextShortcut) globalShortcut.unregister(this.contextShortcut)
    this.contextShortcut = null
    if (!accelerator || process.platform !== 'darwin') return true
    try {
      if (!globalShortcut.register(accelerator, capture)) return false
    } catch {
      return false
    }
    this.contextShortcut = accelerator
    return true
  }

  /** Captures the frontmost app's window, skipping Galaxy Code's own: its screenshot, or its tree as a file when there is none, and the tree as text. */
  async captureFrontApp(): Promise<{ app: string; icon?: string; tree?: string; file: string }> {
    const { accessibility, screen: recording } = this.permissions()
    if (!accessibility && !recording) throw new Error('App Context needs the Accessibility and Screen Recording permissions. Grant them in Settings > Computer Use.')
    const window = (await listWindows()).find(({ layer }) => layer === 0)
    if (!window) throw new Error('No app window is open.')
    const dir = join(tmpdir(), 'galaxy-code', 'app-context', newId())
    await mkdir(dir, { recursive: true })
    const name = window.app.replace(/[/\\:]/g, '-')
    let file: string | undefined
    if (recording) {
      const shot = join(dir, `${name}.png`)
      await run('screencapture', ['-x', '-o', `-l${window.id}`, '-t', 'png', shot], { timeout: 15_000 }).then(() => { file = shot }, () => {})
    }
    let tree: string | undefined
    if (accessibility) {
      const { id: windowId, pid, x, y, width, height } = window
      const reply = await helper<{ nodes: TreeNode[]; truncated: boolean }>({ op: 'tree', windowId, pid, x, y, width, height, menu: false }).catch(() => null)
      if (reply) tree = `Window: ${window.title}\n\n${reply.nodes.map(nodeLine).join('\n')}${reply.truncated ? '\n\nThe tree is cut here.' : ''}`
    }
    if (!file && tree) {
      file = join(dir, `${name} tree.txt`)
      await writeFile(file, tree)
    }
    if (!file) throw new Error(`The ${window.app} window could not be captured.`)
    const icon = await helper<{ icon: string }>({ op: 'icon', pid: window.pid }).then((reply) => `data:image/png;base64,${reply.icon}`, () => undefined)
    return { app: window.app, icon, tree, file }
  }

  /** The name and icon of the app a chat is working in, for its timeline. */
  async currentApp(chatId: string): Promise<{ appName: string; appIcon?: string } | undefined> {
    const window = this.targets.get(chatId)?.window
    if (!window?.pid) return undefined
    const { app: appName, pid } = window
    if (!this.icons.has(pid)) {
      const reply = await helper<{ icon: string }>({ op: 'icon', pid }).catch(() => null)
      if (reply) this.icons.set(pid, `data:image/png;base64,${reply.icon}`)
    }
    return { appName, appIcon: this.icons.get(pid) }
  }

  /** Lets go of every app when Galaxy Code quits, so none is left believing it is active. */
  releaseAll(): void {
    for (const chatId of this.held.keys()) void this.release(chatId)
    this.watch([])
  }

  /** Streams these windows for the live view. Only windows an agent has worked in, so the live view cannot be pointed at anything else. */
  watch(windowIds: number[]): void {
    const allowed = this.permissions().screen ? windowIds.filter((id) => [...this.visited.values()].some((windows) => windows.has(id))) : []
    for (const [id, process] of this.live) {
      if (allowed.includes(id)) continue
      process.kill()
      this.live.delete(id)
    }
    for (const id of allowed) if (!this.live.has(id)) this.streamWindow(id)
  }

  private streamWindow(windowId: number): void {
    const process = spawn(helperPath(), ['stream', String(windowId)], { stdio: ['ignore', 'pipe', 'ignore'] })
    this.live.set(windowId, process)
    let pending = Buffer.alloc(0)
    process.on('error', () => {})
    // A closed window ends its stream, and the same number can then be watched again.
    process.on('exit', () => { if (this.live.get(windowId) === process) this.live.delete(windowId) })
    process.stdout.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 4) {
        const size = pending.readUInt32BE(0)
        if (pending.length < 4 + size) break
        this.onFrame(windowId, pending.subarray(4, 4 + size))
        pending = pending.subarray(4 + size)
      }
    })
  }

  /** Waits for what the agent last did to show, so a read does not report the window from before it took effect. */
  private async settle(target: Target, signal?: AbortSignal): Promise<void> {
    const { actedAt } = target
    if (actedAt === undefined) return
    target.actedAt = undefined
    const mark = (): Promise<string | undefined> => helper<{ state: string }>(this.request(target, 'state')).then(({ state }) => state, () => undefined)
    await sleep(Math.max(0, actedAt + SETTLE_MIN_MS - Date.now()), signal)
    let last = await mark()
    while (Date.now() < actedAt + SETTLE_MAX_MS) {
      await sleep(200, signal)
      const current = await mark()
      if (current === last) return
      last = current
    }
  }

  private async done(target: Target, op: string, fields: Record<string, unknown>): Promise<ComputerResult> {
    // From here on the window may change because of the agent, so there is nothing to compare until it reads again.
    target.seen = undefined
    const { done, dialogs, unchanged } = await helper<{ done: string; dialogs?: string[]; unchanged?: boolean }>(this.request(target, op, fields))
    target.actedAt = Date.now()
    // Clicking can bring the window forward, now or a moment later.
    this.restackCursor()
    setTimeout(() => this.restackCursor(), 350)
    const note = unchanged ? ' Nothing changed even after waiting, so this click may have done nothing. Check with a screenshot; if so, add a request_full_control step and click at x, y.' : ''
    return { text: `${done}.${dialogs?.length ? ` Now open: ${dialogs.join(', ')}. Read the tree to see it.` : ''}${note}` }
  }

  async act(chatId: string, action: ComputerAction, signal?: AbortSignal): Promise<ComputerResult> {
    if (process.platform !== 'darwin') throw new Error('Computer use is only available on macOS.')
    this.assertNotCanceled(chatId)
    this.owners.add(chatId)
    switch (action.action) {
      case 'apps': {
        const windows = await listWindows()
        return { text: windows.length ? windows.map((window) => `${window.app}${window.title ? `: ${window.title}` : ''} (${window.width}x${window.height})${window.layer >= ALERT_LAYER ? ' alert' : ''}`).join('\n') : 'No app windows are open.' }
      }
      case 'open_app': {
        if (!action.app) throw new Error('`app` is required, for example "Safari"')
        await run('open', ['-a', action.app], { timeout: 15_000 })
        return { text: `Opened ${action.app}.` }
      }
      case 'activate': {
        if (!action.app) throw new Error('`app` is required, for example "Safari"')
        this.requireAccessibility()
        const target = await this.pick(chatId, action)
        await helper(this.request(target, 'raise'))
        target.seen = undefined
        return { text: `${target.window.app} is now in front.` }
      }
      case 'tree':
        return this.tree(chatId, action, signal)
      case 'screenshot':
        return this.capture(chatId, action, signal)
      case 'snapshot': {
        // With full control and no app the target is the screen, which has no tree.
        if (this.fullControl.has(chatId) && !action.app) return this.capture(chatId, action, signal)
        const tree = await this.tree(chatId, action, signal)
        // The tree is worth having even if the window cannot be captured.
        const shot = await this.capture(chatId, { ...action, region: undefined }, signal).catch((error: unknown) => ({ text: `No screenshot: ${errorMessage(error)}`, image: undefined }))
        return { text: `${tree.text}\n\n${shot.text}`, image: shot.image }
      }
      case 'click': {
        const target = await this.working(chatId, action)
        const { fields, point } = await this.locate(target, action)
        const pointer = { ...this.pointerFields(action), count: Math.max(1, Math.min(3, action.count ?? 1)) }
        const plain = action.button !== 'right' && !action.modifiers?.length && pointer.count === 1
        const full = this.fullControl.has(chatId)
        // With full control a point is a real click. Otherwise, and for refs, the click goes through accessibility.
        if (full && point && (!action.ref || !plain)) return this.pointerGesture(chatId, target, 'click', [point], pointer, signal)
        // Held keys and triple clicks have no accessibility action, so they go to the window as a gesture.
        if (point && (action.modifiers?.length || pointer.count > 2)) return this.pointerGesture(chatId, target, 'click', [point], pointer, signal)
        if (action.modifiers?.length) this.requireFullControl(chatId, 'A click with modifiers on a menu')
        // A click in place has to name the window it lands in, and an alert is not the target.
        const hit = point && target.window.id ? await this.windowAt(target, point) : null
        await this.hold(chatId, target, hit)
        await this.pointAt(target, point, signal)
        const pressed = this.done(target, 'click', { ...fields, ...(hit ? { hit: [hit.id, hit.x, hit.y, hit.width, hit.height] } : {}), kind: action.button === 'right' ? 'menu' : pointer.count > 1 ? 'open' : 'press' })
        return pressed.catch((error: unknown) => {
          if (full && point) return this.pointerGesture(chatId, target, 'click', [point], pointer, signal)
          throw new Error(`${errorMessage(error)} Read the tree again or scroll to it, and look for another element that does the same. Add a request_full_control step only if that fails too.`)
        })
      }
      case 'move': {
        const target = await this.working(chatId, action)
        return this.pointerGesture(chatId, target, 'move', this.route(target, action), {}, signal)
      }
      case 'drag': {
        const target = await this.working(chatId, action)
        const points = this.route(target, action)
        if (points.length < 2) throw new Error('`drag` needs `toX` and `toY`, or a `path` of at least two points')
        return this.pointerGesture(chatId, target, 'drag', points, this.pointerFields(action), signal)
      }
      case 'type': {
        if (action.text === undefined) throw new Error('`text` is required')
        const target = await this.working(chatId, action)
        await this.keepKeysOffGalaxy(target)
        if (!action.ref) {
          await this.hold(chatId, target, null)
          return this.done(target, 'type', { text: action.text })
        }
        const { fields, point } = await this.locate(target, action)
        await this.hold(chatId, target, null)
        await this.pointAt(target, point, signal)
        return this.done(target, 'type', { ...fields, text: action.text })
      }
      case 'set_value': {
        if (action.text === undefined) throw new Error('`text` is required')
        if (!action.ref) throw new Error('`ref` is required')
        const target = await this.working(chatId, action)
        const { fields, point } = await this.locate(target, action)
        await this.hold(chatId, target, null)
        await this.pointAt(target, point, signal)
        return this.done(target, 'set_value', { ...fields, text: action.text })
      }
      case 'press': {
        if (!action.key) throw new Error('`key` is required, for example "Enter" or "Cmd+N"')
        const target = await this.working(chatId, action)
        await this.keepKeysOffGalaxy(target)
        // The agent's own Esc must not count as the user canceling.
        const parsed = parseKey(action.key)
        const ownEsc = !target.window.id && parsed.code === KEY_CODES.escape
        await this.hold(chatId, target, null)
        if (ownEsc) this.listenForEsc(false)
        const { text } = await this.done(target, 'key', parsed).finally(() => { if (ownEsc && this.fullControl.size) this.listenForEsc(true) })
        return { text: text.replace('Sent.', `Pressed ${action.key}.`) }
      }
      case 'scroll': {
        const target = await this.working(chatId, action)
        const { fields, point } = await this.locate(target, action)
        const amount = Math.max(1, Math.min(20, action.amount ?? 3)) * 0.05
        await this.hold(chatId, target, null)
        await this.pointAt(target, point, signal)
        return this.done(target, 'scroll', { ...fields, delta: action.direction === 'up' || action.direction === 'left' ? -amount : amount, horizontal: action.direction === 'left' || action.direction === 'right' })
      }
      case 'wait':
        await sleep(Math.min(30, Math.max(0.1, action.seconds ?? 1)) * 1000, signal)
        return { text: 'Done waiting.' }
      default:
        throw new Error(`Unknown computer action: ${String((action as ComputerAction).action)}`)
    }
  }

  finishRun(chatId: string): void {
    void this.release(chatId)
    this.inFront.delete(chatId)
    this.onWindow(chatId, null)
    this.targets.delete(chatId)
    this.windows.delete(chatId)
    this.visited.delete(chatId)
    this.watch([...this.live.keys()])
    this.owners.delete(chatId)
    this.canceled.delete(chatId)
    this.asked.delete(chatId)
    if (this.fullControl.delete(chatId) && this.fullControl.size === 0) this.endFullControl()
    if (this.owners.size === 0) this.closeOverlay()
  }
}

export const computer = new ComputerService()
