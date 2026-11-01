import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'

export const SIDEBAR_MIN_WIDTH = 210
export const SIDEBAR_MAX_WIDTH = 420

/** A drag handle on a pane edge. `direction` is which way a rightward drag grows the pane. With `gutter` it sits in the gap that far from the left, so it stays off a scroll bar on the pane's edge. */
export function Resizer({ gutter, width, min, max, direction, onChange, onCommit, onStart, onEnd, onCollapse, onExpand }: { gutter?: number; width: number; min: number; max: number; direction: 1 | -1; onChange(width: number): void; onCommit(width: number): void; onStart?(): void; onEnd?(): void; onCollapse?(): void; onExpand?(): void }): ReactNode {
  const cleanup = useRef<(() => void) | null>(null)
  const latest = useRef(width)
  useEffect(() => () => cleanup.current?.(), [])
  const onDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    cleanup.current?.()
    const pointerId = event.pointerId
    const startX = event.clientX
    // Capture on a persistent element: the pane becomes inert when it collapses.
    const capture = document.documentElement
    let collapsed = false
    let finished = false
    latest.current = width
    const finish = (commit = true): void => {
      if (finished) return
      finished = true
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      capture.removeEventListener('lostpointercapture', end)
      cleanup.current = null
      if (capture.hasPointerCapture(pointerId)) capture.releasePointerCapture(pointerId)
      document.body.style.cursor = ''
      capture.style.cursor = ''
      if (commit) {
        onCommit(latest.current)
        onEnd?.()
      }
    }
    const move = (pointer: PointerEvent): void => {
      if (pointer.pointerId !== pointerId) return
      const requested = width + (pointer.clientX - startX) * direction
      if (requested < min && onCollapse) {
        if (!collapsed) {
          collapsed = true
          latest.current = min
          onChange(min)
          onCollapse()
        }
        return
      }
      const next = Math.max(min, Math.min(max, requested))
      if (!collapsed) onStart?.()
      latest.current = next
      onChange(next)
      if (collapsed) {
        collapsed = false
        onExpand?.()
      }
    }
    const end = (pointer: PointerEvent): void => { if (pointer.pointerId === pointerId) finish() }
    cleanup.current = () => finish(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    capture.addEventListener('lostpointercapture', end)
    capture.setPointerCapture(pointerId)
    onStart?.()
    document.body.style.cursor = 'col-resize'
    capture.style.cursor = 'col-resize'
  }
  return (
    <div
      onPointerDown={onDown}
      className="no-drag absolute inset-y-3 z-20 cursor-col-resize touch-none"
      style={gutter !== undefined ? { left: gutter, width: 6 } : direction === 1 ? { right: 0, width: 9 } : { left: 0, width: 9 }}
    />
  )
}
