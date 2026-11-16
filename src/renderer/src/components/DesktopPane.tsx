import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from 'react'
import { AppWindow, ArrowLeft, MessageSquarePlus, RefreshCw } from 'lucide-react'
import { addComment } from '../lib/comments'
import { CommentBox } from './CommentBox'
import { Button, IconButton } from './ui'
import { useStore } from '../store'
import { LiveCursor } from './ComputerPip'
import { cn } from '../lib/utils'
import type { DesktopInput, DesktopWindow } from '@shared/types'

/** macOS virtual key codes by KeyboardEvent.code. The target app's own keyboard layout turns them into text. */
const KEY_CODES: Record<string, number> = {
  KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5, KeyZ: 6, KeyX: 7, KeyC: 8, KeyV: 9, KeyB: 11, KeyQ: 12, KeyW: 13, KeyE: 14, KeyR: 15,
  KeyY: 16, KeyT: 17, Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21, Digit6: 22, Digit5: 23, Equal: 24, Digit9: 25, Digit7: 26, Minus: 27,
  Digit8: 28, Digit0: 29, BracketRight: 30, KeyO: 31, KeyU: 32, BracketLeft: 33, KeyI: 34, KeyP: 35, Enter: 36, KeyL: 37, KeyJ: 38, Quote: 39,
  KeyK: 40, Semicolon: 41, Backslash: 42, Comma: 43, Slash: 44, KeyN: 45, KeyM: 46, Period: 47, Tab: 48, Space: 49, Backquote: 50,
  Backspace: 51, Escape: 53, MetaRight: 54, MetaLeft: 55, ShiftLeft: 56, CapsLock: 57, AltLeft: 58, ControlLeft: 59, ShiftRight: 60,
  AltRight: 61, ControlRight: 62, Lang1: 104, Lang2: 102, IntlBackslash: 10,
  NumpadDecimal: 65, NumpadMultiply: 67, NumpadAdd: 69, NumLock: 71, NumpadDivide: 75, NumpadEnter: 76, NumpadSubtract: 78, NumpadEqual: 81,
  Numpad0: 82, Numpad1: 83, Numpad2: 84, Numpad3: 85, Numpad4: 86, Numpad5: 87, Numpad6: 88, Numpad7: 89, Numpad8: 91, Numpad9: 92,
  F5: 96, F6: 97, F7: 98, F3: 99, F8: 100, F9: 101, F11: 103, F10: 109, F12: 111, F4: 118, F2: 120, F1: 122,
  Home: 115, PageUp: 116, Delete: 117, End: 119, PageDown: 121, ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126
}

function flags(event: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): number {
  return (event.shiftKey ? 0x20000 : 0) | (event.ctrlKey ? 0x40000 : 0) | (event.altKey ? 0x80000 : 0) | (event.metaKey ? 0x100000 : 0)
}

function windowTitle(entry: DesktopWindow): string {
  return entry.title ? `${entry.app} — ${entry.title}` : entry.app
}

/** Lists open app windows, then shows the picked one live and passes the user's mouse and keyboard to it. */
export function DesktopPane({ tabId, visible }: { tabId: string; visible: boolean }): ReactNode {
  const [windows, setWindows] = useState<DesktopWindow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [target, setTarget] = useState<DesktopWindow | null>(null)
  const [frame, setFrame] = useState<string | null>(null)
  const image = useRef<HTMLImageElement | null>(null)
  const surface = useRef<HTMLDivElement | null>(null)
  const queue = useRef<DesktopInput[]>([])
  const scheduled = useRef(false)
  const pressed = useRef(false)
  /** When the latest frame came, and when the stream was last restarted, to restart a stalled stream when the user acts. */
  const lastFrame = useRef(0)
  const revivedAt = useRef(0)
  const agentHere = useStore((state) => !!target && Object.values(state.computerWindows).some((list) => list.some((entry) => entry.id === target.id)))
  const [commenting, setCommenting] = useState(false)
  const pendingComments = useStore((state) => state.composerComments[state.activeChatId ?? 'new']?.length ?? 0)
  const [sending, setSending] = useState<{ x: number; y: number } | null>(null)
  /** The area being dragged or picked for a comment, in window points, and the picture it was picked on. */
  const [area, setArea] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const dragFrom = useRef<{ x: number; y: number } | null>(null)
  const [picked, setPicked] = useState<{ rect: { x: number; y: number; width: number; height: number }; src: string; at: { x: number; y: number } } | null>(null)

  // A window open here is left out of the PIP, so it is not streamed twice.
  useEffect(() => {
    useStore.setState((state) => {
      const desktopViews = { ...state.desktopViews }
      if (target) desktopViews[tabId] = target.id
      else delete desktopViews[tabId]
      return { desktopViews }
    })
    return () => useStore.setState((state) => {
      const desktopViews = { ...state.desktopViews }
      delete desktopViews[tabId]
      return { desktopViews }
    })
  }, [tabId, target?.id])

  // The tab shows the viewed app's name and icon, and Desktop Apps while picking.
  useEffect(() => {
    useStore.setState((state) => ({
      panelTabs: state.panelTabs.map((tab) => tab.id === tabId && tab.type === 'desktop' ? { ...tab, title: target?.app ?? 'Desktop Apps', icon: target?.icon } : tab)
    }))
  }, [tabId, target?.app, target?.icon])

  const refresh = useCallback(() => {
    setError(null)
    window.galaxy.computer.desktopWindows().then(setWindows, (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [])

  useEffect(() => { if (visible && !target) refresh() }, [visible, target, refresh])

  // Stream the picked window while the tab is open, and keep its size current in case the user resizes it.
  useEffect(() => {
    if (!target) return
    const id = target.id
    let latest: string | null = null
    const off = window.galaxy.onUiEvent((event) => {
      if (event.type !== 'computer-frame' || event.windowId !== id) return
      const url = URL.createObjectURL(new Blob([event.image as BlobPart], { type: event.mime }))
      if (latest) URL.revokeObjectURL(latest)
      latest = url
      lastFrame.current = Date.now()
      setFrame(url)
    })
    lastFrame.current = Date.now()
    window.galaxy.computer.viewDesktop(id).catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)); setTarget(null) })
    const timer = setInterval(() => {
      void window.galaxy.computer.desktopWindows().then((list) => {
        const current = list.find((entry) => entry.id === id)
        if (!current) { setTarget(null); setError('The window was closed.'); return }
        setTarget((previous) => previous && previous.id === id && (previous.width !== current.width || previous.height !== current.height || previous.title !== current.title) ? current : previous)
      }, () => {})
    }, 2000)
    return () => {
      off()
      clearInterval(timer)
      void window.galaxy.computer.unviewDesktop(id)
      if (latest) URL.revokeObjectURL(latest)
      setFrame(null)
    }
  }, [target?.id])

  const send = useCallback((event: DesktopInput) => {
    if (!target) return
    // Acting on a window should change it, so a picture that stays old after that means the capture stalled.
    if (event.t !== 'move' && event.t !== 'drag') {
      const sentAt = Date.now()
      setTimeout(() => {
        if (lastFrame.current >= sentAt || Date.now() - revivedAt.current < 4000) return
        revivedAt.current = Date.now()
        void window.galaxy.computer.reviveDesktop(target.id)
      }, 2500)
    }
    const last = queue.current.at(-1)
    // Only the latest pointer move between two frames matters.
    if (last && (event.t === 'move' || event.t === 'drag') && last.t === event.t) queue.current[queue.current.length - 1] = event
    else queue.current.push(event)
    if (scheduled.current) return
    scheduled.current = true
    requestAnimationFrame(() => {
      scheduled.current = false
      const events = queue.current
      queue.current = []
      if (events.length) window.galaxy.computer.desktopInput(target.id, events).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
    })
  }, [target])

  const point = (event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const box = image.current?.getBoundingClientRect()
    if (!box || !target || !box.width || !box.height) return null
    return {
      x: Math.max(0, Math.min(target.width, ((event.clientX - box.left) / box.width) * target.width)),
      y: Math.max(0, Math.min(target.height, ((event.clientY - box.top) / box.height) * target.height))
    }
  }

  /** The picture as it is now, as a data URL that outlives the stream's frame URLs. */
  const snapshot = (): string => {
    const img = image.current
    if (!img) return ''
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    canvas.getContext('2d')?.drawImage(img, 0, 0)
    return canvas.toDataURL('image/png')
  }

  const onCommentPointer = (kind: 'down' | 'up' | 'move', event: ReactPointerEvent<HTMLImageElement>, at: { x: number; y: number }): void => {
    event.preventDefault()
    if (kind === 'down') {
      event.currentTarget.setPointerCapture(event.pointerId)
      dragFrom.current = at
      setPicked(null)
      setArea({ ...at, width: 0, height: 0 })
      return
    }
    const from = dragFrom.current
    if (!from) return
    const rect = { x: Math.min(from.x, at.x), y: Math.min(from.y, at.y), width: Math.abs(at.x - from.x), height: Math.abs(at.y - from.y) }
    if (kind === 'move') { setArea(rect); return }
    dragFrom.current = null
    // A click without a drag marks a small area around the point.
    const size = 24
    const final = rect.width < 4 && rect.height < 4 && target ? { x: Math.max(0, at.x - size / 2), y: Math.max(0, at.y - size / 2), width: size, height: size } : rect
    setArea(final)
    setPicked({ rect: final, src: snapshot(), at: { x: event.clientX, y: event.clientY + 8 } })
    setCommenting(false)
  }

  const onPointer = (kind: 'down' | 'up' | 'move') => (event: ReactPointerEvent<HTMLImageElement>) => {
    const at = point(event)
    if (!at) return
    if (commenting) { onCommentPointer(kind, event, at); return }
    const button = event.button === 2 ? 2 : 0
    if (kind === 'down') {
      surface.current?.focus()
      event.currentTarget.setPointerCapture(event.pointerId)
      pressed.current = true
      send({ t: 'down', ...at, button, clicks: Math.max(1, event.detail), flags: flags(event) })
    } else if (kind === 'up') {
      if (!pressed.current) return
      pressed.current = false
      send({ t: 'up', ...at, button, clicks: Math.max(1, event.detail), flags: flags(event) })
    } else {
      send({ t: pressed.current ? 'drag' : 'move', ...at, button: event.buttons & 2 ? 2 : 0, flags: flags(event) })
    }
    event.preventDefault()
  }

  const onWheel = (event: ReactWheelEvent<HTMLImageElement>) => {
    const at = point(event)
    if (at) send({ t: 'scroll', ...at, dx: event.deltaX, dy: event.deltaY })
  }

  const onKey = (down: boolean) => (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const code = KEY_CODES[event.code]
    if (code === undefined || commenting || picked || sending) return
    event.preventDefault()
    event.stopPropagation()
    send({ t: 'key', code, down, flags: flags(event) })
  }

  if (target) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-2 text-[12px] text-muted">
          <button type="button" title="Pick another window" onClick={() => setTarget(null)} className="flex h-6 w-6 items-center justify-center rounded hover:bg-hover hover:text-fg"><ArrowLeft size={14} /></button>
          {target.icon ? <img src={target.icon} alt="" className="h-4 w-4" /> : <AppWindow size={14} />}
          <span className="min-w-0 flex-1 truncate">{windowTitle(target)}</span>
          <span className="shrink-0 text-subtle">{commenting ? 'Click or drag an area to comment' : 'Click the picture to control it'}</span>
          <IconButton label={commenting ? 'Cancel commenting' : 'Comment on the window: click a point or drag an area'} active={commenting} disabled={!frame} onClick={() => { setCommenting((on) => !on); setPicked(null); setArea(null) }}>
            <MessageSquarePlus size={14} />
          </IconButton>
          {pendingComments > 0 && (
            <Button size="sm" title="Write the message and send it with your comments" onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); setSending((current) => current ? null : { x: box.right - 300, y: box.bottom + 6 }) }}>
              Comment
            </Button>
          )}
          {sending && <CommentBox send x={sending.x} y={sending.y} title="Message" onClose={() => setSending(null)} onSubmit={(note) => { const state = useStore.getState(); const key = state.activeChatId ?? 'new'; const current = state.composerText[key] ?? ''; state.setComposerText(key, current ? `${current.replace(/\s+$/, '')}\n${note.trim()}` : note.trim()) }} />}
        </div>
        {error && <div className="border-b border-line px-3 py-1.5 text-[12px] text-[#ff453a]">{error}</div>}
        <div
          ref={surface}
          tabIndex={0}
          onKeyDown={onKey(true)}
          onKeyUp={onKey(false)}
          className="flex min-h-0 flex-1 items-center justify-center bg-inset p-2 outline-none focus:ring-1 focus:ring-inset focus:ring-line-strong"
        >
          {frame
            ? <div className="relative flex max-h-full max-w-full"><img
                ref={image}
                src={frame}
                alt=""
                draggable={false}
                onPointerDown={onPointer('down')}
                onPointerUp={onPointer('up')}
                onPointerMove={onPointer('move')}
                onWheel={onWheel}
                onContextMenu={(event) => event.preventDefault()}
                className={cn('max-h-full max-w-full select-none object-contain shadow-lg', commenting && 'cursor-crosshair')}
                style={{ aspectRatio: `${target.width} / ${target.height}` }}
              />
              {agentHere && <LiveCursor windowId={target.id} />}
              {area && (commenting || picked) && (
                <div
                  className="pointer-events-none absolute border-2 border-[#ff3b30] bg-[#ff3b30]/10"
                  style={{ left: `${(area.x / target.width) * 100}%`, top: `${(area.y / target.height) * 100}%`, width: `${(area.width / target.width) * 100}%`, height: `${(area.height / target.height) * 100}%` }}
                />
              )}
              </div>
            : <div className="text-[12px] text-subtle">Connecting…</div>}
        </div>
        {picked && (
          <CommentBox
            x={picked.at.x}
            y={picked.at.y}
            title={`Area in ${target.app}`}
            onClose={() => { setPicked(null); setArea(null) }}
            onSubmit={(note) => {
              const { rect, src } = picked
              addComment({
                source: windowTitle(target),
                detail: `desktop app window; x ${Math.round(rect.x)}, y ${Math.round(rect.y)}, ${Math.round(rect.width)}x${Math.round(rect.height)} pt of the ${Math.round(target.width)}x${Math.round(target.height)} pt window`,
                note,
                area: { group: `desktop:${target.id}:${src.length}:${src.slice(-64)}`, src, rect, reference: { width: target.width, height: target.height } }
              })
            }}
          />
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 text-[12px] text-muted">
        <AppWindow size={14} />
        <span className="flex-1">Desktop Apps</span>
        <button type="button" title="Refresh" onClick={refresh} className="flex h-6 w-6 items-center justify-center rounded hover:bg-hover hover:text-fg"><RefreshCw size={13} /></button>
      </div>
      {error && <div className="border-b border-line px-3 py-1.5 text-[12px] text-[#ff453a]">{error}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {windows === null && !error && <div className="p-3 text-[12px] text-subtle">Loading windows…</div>}
        {windows?.length === 0 && <div className="p-3 text-[12px] text-subtle">No app windows are open.</div>}
        {windows?.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => { setError(null); setTarget(entry) }}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] text-fg hover:bg-hover"
          >
            {entry.icon ? <img src={entry.icon} alt="" className="h-6 w-6 shrink-0" /> : <AppWindow size={20} className="shrink-0 text-muted" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate">{entry.app}</span>
              {entry.title && <span className="block truncate text-[11.5px] text-subtle">{entry.title}</span>}
            </span>
            <span className="shrink-0 text-[11px] text-subtle">{Math.round(entry.width)}×{Math.round(entry.height)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
