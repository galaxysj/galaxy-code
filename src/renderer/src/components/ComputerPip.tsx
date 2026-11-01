import { X } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { ComputerWindow } from '@shared/types'
import { useStore } from '../store'
import { IconButton } from './ui'

const PIP_WIDTH = 320
const FIRST_FRAME_TIMEOUT_MS = 5000
/** How many other windows show as cards behind the picture, the most recent nearest. */
const MAX_BEHIND = 4
const NO_WINDOWS: ComputerWindow[] = []
const SWITCH_MS = 220
const CURSOR_SIZE = 20
/** How small the cursor gets when it presses, the same as on the desktop. */
const CURSOR_PRESSED = 'scale(.78)'
const CURSOR_EASING = 'cubic-bezier(.2,.8,.2,1)'
/** Where the tip of the arrow is in the drawing, as a share of its size. */
const CURSOR_TIP = 4.21875 / 30
const CURSOR_PATH = 'M6.8 4.5 C5.2 3.9 4.1 5.1 4.7 6.8 L10.6 22 C11.1 23.3 12.5 23.2 13 21.9 L15.1 16.6 C15.4 15.9 15.9 15.4 16.6 15.1 L21.9 13 C23.2 12.5 23.3 11.1 22 10.6 Z'

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
    <div ref={card} className="relative overflow-hidden rounded-lg bg-elev shadow-pop">
      <div onPointerDown={onDrag} className="flex h-8 cursor-move select-none items-center gap-2 pl-3 pr-1 text-[12px] text-fg">
        <span className="min-w-0 flex-1 truncate" title={title}>{title}</span>
        <IconButton label="Close live view" size="sm" onClick={onClose}><X size={13} /></IconButton>
      </div>
      {failed
        ? <div className="px-3 pb-3 text-[12px] text-muted">The live view is not available for this window.</div>
        : (
          <div className="relative overflow-hidden">
            <div className="w-full bg-black" style={{ aspectRatio: `${target.width} / ${target.height}` }}>
              {frame && <img src={frame} alt="" className="block h-full w-full" />}
            </div>
            <LiveCursor windowId={target.id} />
          </div>
        )}
    </div>
  )
}

/** Shows the windows the open chat's agent has worked in as a stack. The picture follows the agent, and a click on a card behind it shows that window until the agent moves on. */
export function ComputerPip(): ReactNode {
  const windows = useStore((s) => (s.activeChatId ? s.computerWindows[s.activeChatId] : undefined)) ?? NO_WINDOWS
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

  useEffect(() => {
    const ids = shown ? shown.split(',').map(Number) : []
    void window.galaxy.computer.watch(ids)
    for (const [id, url] of frames.current) {
      if (ids.includes(id)) continue
      URL.revokeObjectURL(url)
      frames.current.delete(id)
    }
  }, [shown])

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).closest('button')) return
    const start = { x: event.clientX, y: event.clientY, ...offset }
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
    <div className="pop-in fixed z-[55]" style={{ ...offset, width: PIP_WIDTH }}>
      {behind.map((entry, index) => (
        <button
          key={entry.id}
          type="button"
          title={`Show ${windowTitle(entry)}`}
          onClick={() => setChosen({ id: entry.id, latest: latest.id })}
          className="relative -mb-2 block h-8 truncate rounded-t-lg bg-elev px-3 pt-1 text-left text-[11.5px] text-muted shadow-pop transition-colors hover:text-fg"
          style={{ width: `calc(100% - ${(behind.length - index) * 16}px)`, marginInline: 'auto' }}
        >
          {windowTitle(entry)}
        </button>
      ))}
      <LiveWindow key={front.id} target={front} frame={frames.current.get(front.id)} onDrag={startDrag} onClose={() => setClosed([...closed, front.id])} />
    </div>
  )
}
