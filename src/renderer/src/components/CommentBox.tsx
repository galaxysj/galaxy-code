import { MessageSquarePlus } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { addComment, markPending, requestSend } from '../lib/comments'
import { cn } from '../lib/utils'
import { Button } from './ui'

const WIDTH = 300

/** A small note box at a point on screen. Add puts the comment into the message being written. */
export function CommentBox({ x, y, title, send = false, onSubmit, onClose }: { x: number; y: number; title?: string; /** The box writes the final message and sends it, instead of adding a comment. */ send?: boolean; onSubmit(note: string): void | Promise<void>; onClose(): void }): ReactNode {
  const [note, setNote] = useState('')
  const [pos, setPos] = useState({ left: x, top: y })
  const box = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const height = box.current?.offsetHeight ?? 130
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - WIDTH - 8)), top: Math.max(8, Math.min(y, window.innerHeight - height - 8)) })
  }, [x, y])
  useEffect(() => area.current?.focus(), [])
  const submit = (): void => {
    if (!note.trim()) return
    void Promise.resolve(onSubmit(note)).then(() => {
      // Send puts the text in the message box and sends it with every comment added so far.
      if (send) requestSend()
      onClose()
    })
  }
  return createPortal(
    <div ref={box} onMouseDown={(event) => event.stopPropagation()} onMouseUp={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()} className="pop-in fixed z-[60] rounded-xl border border-line bg-elev p-2 shadow-[0_6px_24px_rgba(0,0,0,0.14)]" style={{ left: pos.left, top: pos.top, width: WIDTH }}>
      {title && <div className="mb-1.5 truncate px-1 text-[11.5px] text-subtle">{title}</div>}
      <textarea
        ref={area}
        value={note}
        rows={3}
        placeholder={send ? 'Write the message to send with your comments' : 'Write a comment'}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
          else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit() }
        }}
        className="w-full resize-none rounded-lg border border-line bg-bg px-2 py-1.5 text-[13px] text-fg outline-none placeholder:text-subtle focus:border-line-strong"
      />
      <div className="mt-1.5 flex justify-end gap-1.5">
        <Button size="sm" onClick={onClose}>Cancel</Button>
        {send
          ? <Button size="sm" variant="primary" disabled={!note.trim()} onClick={submit}>Send</Button>
          : <Button size="sm" variant="primary" disabled={!note.trim()} title="Keep it with the message you are writing" onClick={submit}>Add</Button>}
      </div>
    </div>,
    document.body
  )
}

/** A selection made somewhere on screen: the button appears at its end, and opens the note box. */
export interface SelectionPoint {
  range?: Range
  x: number
  y: number
  quote: string
  detail?: string
}

export function CommentFloat({ point, source, onClose }: { point: SelectionPoint; source: string; onClose(): void }): ReactNode {
  const [open, setOpen] = useState(false)
  // The selection disappears once the note box takes focus, so it is kept marked meanwhile.
  useEffect(() => {
    if (!open) return
    markPending(point.range ?? null)
    return () => markPending(null)
  }, [open, point.range])
  if (open) return <CommentBox x={point.x} y={point.y + 6} title={point.quote.replace(/\s+/g, ' ').slice(0, 80)} onClose={onClose} onSubmit={(note) => { markPending(null); addComment({ source, detail: point.detail, quote: point.quote, note }, point.range) }} />
  return createPortal(
    <button
      type="button"
      title="Comment on the selection"
      onMouseDown={(event) => event.preventDefault()}
      onMouseUp={(event) => event.stopPropagation()}
      onClick={() => setOpen(true)}
      className="pop-in fixed z-[60] flex h-7 items-center gap-1.5 rounded-lg border border-line bg-elev px-2 text-[12px] text-fg shadow-[0_4px_16px_rgba(0,0,0,0.12)] hover:bg-[linear-gradient(var(--bg-hover),var(--bg-hover))]"
      style={{ left: Math.max(8, Math.min(point.x, window.innerWidth - 100)), top: Math.min(point.y + 6, window.innerHeight - 40) }}
    >
      <MessageSquarePlus size={13} /> Comment
    </button>,
    document.body
  )
}

/** Wraps text that can be selected with the mouse; a selection inside it offers a comment. `content` lets it name the lines. */
export function SelectionComment({ source, content, className, children }: { source: string; content?: string; className?: string; children: ReactNode }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [point, setPoint] = useState<SelectionPoint | null>(null)
  const check = (): void => {
    window.setTimeout(() => {
      const selection = window.getSelection()
      const quote = selection?.toString().trim() ?? ''
      if (!selection || selection.isCollapsed || !quote || !ref.current?.contains(selection.anchorNode) || !ref.current.contains(selection.focusNode)) {
        setPoint(null)
        return
      }
      const range = selection.getRangeAt(0).cloneRange()
      // The button sits at the end of the last selected line, not at the corner of the whole block.
      const rects = range.getClientRects()
      const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect()
      let detail: string | undefined
      if (content) {
        const at = content.indexOf(quote.split('\n')[0].trim())
        if (at >= 0) {
          const start = content.slice(0, at).split('\n').length
          const end = start + quote.split('\n').length - 1
          detail = end > start ? `lines ${start}-${end}` : `line ${start}`
        }
      }
      setPoint({ x: rect.right, y: rect.bottom, quote, detail, range })
    }, 0)
  }
  return (
    <div ref={ref} className={className} onMouseUp={check} onKeyUp={check}>
      {children}
      {point && <CommentFloat key={`${point.x}:${point.y}:${point.quote.length}`} point={point} source={source} onClose={() => { setPoint(null); window.getSelection()?.removeAllRanges() }} />}
    </div>
  )
}

type Area = { x: number; y: number; width: number; height: number }

/** A picture the user can drag a rectangle on to comment on that part. The comment carries the picture with the area outlined. */
export function CommentableImage({ src, source, alt, className }: { src: string; source: string; alt: string; className?: string }): ReactNode {
  const img = useRef<HTMLImageElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  // The picture is sized to the room its container leaves, so the frame around it matches it exactly. A percentage height would not resolve here.
  const [limit, setLimit] = useState<{ width: number; height: number } | null>(null)
  useLayoutEffect(() => {
    const parent = frame.current?.parentElement
    if (!parent) return
    const measure = (): void => {
      const style = getComputedStyle(parent)
      const width = parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const height = parent.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
      setLimit(width > 0 && height > 0 ? { width, height } : null)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [])
  const [area, setArea] = useState<Area | null>(null)
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const local = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const box = img.current!.getBoundingClientRect()
    return { x: Math.max(0, Math.min(box.width, event.clientX - box.left)), y: Math.max(0, Math.min(box.height, event.clientY - box.top)) }
  }
  const span = (a: { x: number; y: number }, b: { x: number; y: number }): Area => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) })
  return (
    <div ref={frame} className="relative inline-block max-w-full select-none align-top leading-[0]">
      <img ref={img} src={src} alt={alt} className={cn('block', className)} style={limit ? { maxWidth: limit.width, maxHeight: limit.height } : undefined} draggable={false} />
      <div
        className="absolute inset-0 cursor-crosshair"
        title="Drag to comment on an area"
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          start.current = local(event)
          setAt(null)
          setArea(null)
        }}
        onPointerMove={(event) => { if (start.current) setArea(span(start.current, local(event))) }}
        onPointerUp={(event) => {
          if (!start.current) return
          const box = span(start.current, local(event))
          start.current = null
          if (box.width < 6 || box.height < 6) { setArea(null); return }
          setArea(box)
          setAt({ x: event.clientX, y: event.clientY })
        }}
      >
        {area && <div className="pointer-events-none absolute border-2 border-[#ff3b30] bg-[#ff3b30]/10" style={{ left: area.x, top: area.y, width: area.width, height: area.height }} />}
      </div>
      {area && at && (
        <CommentBox
          x={at.x + 8}
          y={at.y + 8}
          title={`${source}, selected area`}
          onClose={() => { setArea(null); setAt(null) }}
          onSubmit={(note) => {
            const shown = img.current!
            const sx = shown.naturalWidth / shown.clientWidth
            const sy = shown.naturalHeight / shown.clientHeight
            addComment({
              source,
              detail: `area x ${Math.round(area.x * sx)}, y ${Math.round(area.y * sy)}, ${Math.round(area.width * sx)}x${Math.round(area.height * sy)} px of ${shown.naturalWidth}x${shown.naturalHeight}`,
              note,
              area: { group: src, src, rect: area, reference: { width: shown.clientWidth, height: shown.clientHeight } }
            })
          }}
        />
      )}
    </div>
  )
}
