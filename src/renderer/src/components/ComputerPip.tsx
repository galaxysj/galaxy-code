import { X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { ComputerWindow } from '@shared/types'
import { useStore } from '../store'
import { IconButton } from './ui'

const PIP_WIDTH = 320
/** The picture area is a fixed size, and a window of any shape fits inside it. */
const PIP_HEIGHT = 200
const FIRST_FRAME_TIMEOUT_MS = 5000
/** How many other windows show as cards behind the picture, the most recent nearest. */
const MAX_BEHIND = 4
const NO_WINDOWS: ComputerWindow[] = []
/** How often a browser tab's picture refreshes. */
const BROWSER_FRAME_MS = 600
/** Browser tabs share the stack with app windows under negative ids, which no app window has. */
const browserIds = new Map<string, number>()
const browserIdFor = (tabId: string): number => {
  if (!browserIds.has(tabId)) browserIds.set(tabId, -(browserIds.size + 1))
  return browserIds.get(tabId)!
}
const tabForId = (id: number): string | undefined => [...browserIds].find(([, value]) => value === id)?.[0]
const SWITCH_MS = 220
const CURSOR_SIZE = 20
/** How small the cursor gets when it presses, the same as on the desktop. */
const CURSOR_PRESSED = 'scale(.78)'
const CURSOR_EASING = 'cubic-bezier(.2,.8,.2,1)'
/** Where the tip of the arrow is in the drawing, as a share of its size. */
const CURSOR_TIP = 4.21875 / 30
const CURSOR_PATH = 'M6.8 4.5 C5.2 3.9 4.1 5.1 4.7 6.8 L10.6 22 C11.1 23.3 12.5 23.2 13 21.9 L15.1 16.6 C15.4 15.9 15.9 15.4 16.6 15.1 L21.9 13 C23.2 12.5 23.3 11.1 22 10.6 Z'

/** The window's picture scaled to fit the fixed picture area, keeping its shape. */
function fitted(width: number, height: number): { width: number; height: number } {
  const ratio = width > 0 && height > 0 ? width / height : PIP_WIDTH / PIP_HEIGHT
  return ratio >= PIP_WIDTH / PIP_HEIGHT ? { width: PIP_WIDTH, height: PIP_WIDTH / ratio } : { width: PIP_HEIGHT * ratio, height: PIP_HEIGHT }
}

function windowTitle(entry: ComputerWindow): string {
  return entry.title ? `${entry.app}: ${entry.title}` : entry.app
}

/** The agent cursor over the picture. It lives in a window of its own on the desktop, so the capture never shows it. */
function LiveCursor({ windowId }: { windowId: number }): ReactNode {
  const cursor = useStore((s) => s.computerCursor)
  const glyph = useRef<SVGSVGElement>(null)
  const pressing = useRef<Animation | undefined>(undefined)
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const press = cursor?.press
  useEffect(() => {
    if (!press || reduced) return
    pressing.current?.cancel()
    if (press === 'click') pressing.current = glyph.current?.animate([{ transform: 'scale(1)' }, { transform: CURSOR_PRESSED, offset: 0.35 }, { transform: 'scale(1)' }], { duration: 240, easing: CURSOR_EASING })
    // A drag stays pressed until its button comes up.
    if (press === 'down') pressing.current = glyph.current?.animate([{ transform: 'scale(1)' }, { transform: CURSOR_PRESSED }], { duration: 110, easing: CURSOR_EASING, fill: 'forwards' })
    if (press === 'up') pressing.current = glyph.current?.animate([{ transform: CURSOR_PRESSED }, { transform: 'scale(1)' }], { duration: 140, easing: CURSOR_EASING })
  }, [cursor, press, reduced])
  if (cursor?.windowId !== windowId) return null
  const motion = reduced ? 'none' : `left ${cursor.duration}ms cubic-bezier(.22,1,.36,1), top ${cursor.duration}ms cubic-bezier(.22,1,.36,1)`
  return (
    <div aria-hidden="true" className="pointer-events-none absolute" style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%`, marginLeft: -CURSOR_SIZE * CURSOR_TIP, marginTop: -CURSOR_SIZE * CURSOR_TIP, transition: motion }}>
      <svg ref={glyph} width={CURSOR_SIZE} height={CURSOR_SIZE} viewBox="0 0 32 32" fill="none" style={{ display: 'block', overflow: 'visible', transformOrigin: `${CURSOR_TIP * 100}% ${CURSOR_TIP * 100}%` }}>
        <path d={CURSOR_PATH} stroke="#258BFF" strokeOpacity=".5" strokeWidth="4.2" strokeLinejoin="round" />
        <path d={CURSOR_PATH} fill="#050505" stroke="#FFFFFF" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
    </div>
  )
}

/** The picture of one window. It comes up out of the stack each time the window it shows changes. */
function LiveWindow({ target, frame, onClose, onDrag }: { target: ComputerWindow; frame: string | undefined; onClose: () => void; onDrag: (event: ReactPointerEvent<HTMLDivElement>) => void }): ReactNode {
  const card = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  // A browser tab takes the shape of its pictures, an app window the shape it reports.
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const size = fitted(natural?.width ?? target.width, natural?.height ?? target.height)
  const waiting = frame === undefined

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    card.current?.animate([{ opacity: 0.4, transform: 'translateY(-14px) scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: SWITCH_MS, easing: 'cubic-bezier(.22,1,.36,1)' })
  }, [])

  useEffect(() => {
    setFailed(false)
    if (!waiting) return
    const timeout = setTimeout(() => setFailed(true), FIRST_FRAME_TIMEOUT_MS)
    return () => clearTimeout(timeout)
  }, [waiting])

  const title = windowTitle(target)
  return (
    <div ref={card} className="group/pip relative overflow-hidden rounded-lg bg-elev shadow-pop" style={{ width: Math.round(size.width) }}>
      {/* Only the picture shows: it drags the card, and the close button comes up on hover. */}
      <div onPointerDown={onDrag} title={title} className="absolute inset-0 z-10 cursor-move select-none" />
      <div className="absolute right-1 top-1 z-20 rounded-md bg-elev/90 opacity-0 transition-opacity group-hover/pip:opacity-100">
        <IconButton label="Close live view" size="sm" onClick={onClose}><X size={13} /></IconButton>
      </div>
      {failed
        ? <div className="px-3 py-3 text-[12px] text-muted">The live view is not available for this window.</div>
        : (
          <div className="relative overflow-hidden" style={size}>
              {frame && <img src={frame} alt="" className="block h-full w-full" onLoad={target.id < 0 ? (event) => { const { naturalWidth: width, naturalHeight: height } = event.currentTarget; if (width && height && (width !== natural?.width || height !== natural?.height)) setNatural({ width, height }) } : undefined} />}
              <LiveCursor windowId={target.id} />
          </div>
        )}
    </div>
  )
}

/** Shows the windows the open chat's agent has worked in as a stack. The picture follows the agent, and a click on a card behind it shows that window until the agent moves on. */
export function ComputerPip({ inset = 0 }: { inset?: number }): ReactNode {
  const apps = useStore((s) => (s.activeChatId ? s.computerWindows[s.activeChatId] : undefined)) ?? NO_WINDOWS
  // Tabs the agent is browsing in, while the side panel does not show them.
  const browserKey = useStore((s) => Object.entries(s.browserStates)
    .filter(([tabId, state]) => tabId.startsWith('browser_') && state.agentActive && !(s.panelOpen && s.panelTab === tabId))
    .map(([tabId, state]) => `${tabId}\u0000${state.title || state.url || 'Browser'}`).join('\u0001'))
  const windows = useMemo(() => {
    const tabs = browserKey ? browserKey.split('\u0001').map((entry) => {
      const [tabId, title] = entry.split('\u0000')
      return { id: browserIdFor(tabId), app: 'Browser', title, width: 16, height: 10 }
    }) : []
    return tabs.length ? [...apps, ...tabs] : apps
  }, [apps, browserKey])
  const [closed, setClosed] = useState<number[]>([])
  const [chosen, setChosen] = useState<{ id: number; latest: number } | null>(null)
  // Pixels from the top right corner, below the header, so the stack stays in the window when it is resized.
  const [offset, setOffset] = useState({ right: 20, top: 56 })
  // Every shown window streams all the time, so a switch has its latest picture ready. Only the one in front redraws.
  const frames = useRef(new Map<number, string>())
  const frontId = useRef<number | null>(null)
  const [, redraw] = useState(0)

  const open = windows.filter(({ id }) => !closed.includes(id))
  const latest = open[open.length - 1]
  const front = latest && ((chosen?.latest === latest.id && open.find(({ id }) => id === chosen.id)) || latest)
  const behind = front ? open.filter(({ id }) => id !== front.id).slice(-MAX_BEHIND) : []
  const shown = (front ? [...behind, front] : []).map(({ id }) => id).sort((a, b) => a - b).join(',')
  frontId.current = front?.id ?? null

  useEffect(() => {
    if (windows.length === 0) setClosed([])
  }, [windows.length])

  useEffect(() => window.galaxy.onUiEvent((event) => {
    if (event.type !== 'computer-frame') return
    const previous = frames.current.get(event.windowId)
    if (previous) URL.revokeObjectURL(previous)
    frames.current.set(event.windowId, URL.createObjectURL(new Blob([event.jpeg as BlobPart], { type: 'image/jpeg' })))
    if (event.windowId === frontId.current) redraw((count) => count + 1)
  }), [])

  // A browser tab in front is pictured by capturing it again and again.
  const frontBrowser = front && front.id < 0 ? tabForId(front.id) : undefined
  useEffect(() => {
    if (!frontBrowser) return
    const id = browserIdFor(frontBrowser)
    let stopped = false
    const tick = async (): Promise<void> => {
      const frame = await window.galaxy.browser.frame(frontBrowser).catch(() => null)
      if (stopped) return
      if (frame) {
        frames.current.set(id, frame)
        redraw((count) => count + 1)
      }
      setTimeout(() => void tick(), BROWSER_FRAME_MS)
    }
    void tick()
    return () => { stopped = true }
  }, [frontBrowser])

  useEffect(() => {
    const ids = shown ? shown.split(',').map(Number) : []
    void window.galaxy.computer.watch(ids.filter((id) => id >= 0))
    for (const [id, url] of frames.current) {
      if (ids.includes(id)) continue
      if (url.startsWith('blob:')) URL.revokeObjectURL(url)
      frames.current.delete(id)
    }
  }, [shown])

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).closest('button')) return
    const start = { x: event.clientX, y: event.clientY, top: offset.top, right: Math.max(offset.right, inset ? inset + 14 : 0) }
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent): void => setOffset({ right: Math.max(0, start.right + start.x - next.clientX), top: Math.max(0, start.top + next.clientY - start.y) })
    const end = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  if (!latest || !front) return null
  return (
    <div className="pop-in fixed z-[55]" style={{ top: offset.top, right: Math.max(offset.right, inset ? inset + 14 : 0) }}>
      {behind.map((entry, index) => (
        <button
          key={entry.id}
          type="button"
          title={`Show ${windowTitle(entry)}`}
          onClick={() => setChosen({ id: entry.id, latest: latest.id })}
          className="relative -mb-2 block h-8 overflow-hidden rounded-t-lg bg-elev shadow-pop transition-opacity hover:opacity-90"
          style={{ width: `calc(100% - ${(behind.length - index) * 16}px)`, marginInline: 'auto' }}
        >
          {/* The top edge of the window's latest picture. */}
          {frames.current.get(entry.id) && <img src={frames.current.get(entry.id)} alt="" className="block h-full w-full object-cover object-top" />}
        </button>
      ))}
      <LiveWindow key={front.id} target={front} frame={frames.current.get(front.id)} onDrag={startDrag} onClose={() => setClosed([...closed, front.id])} />
    </div>
  )
}
