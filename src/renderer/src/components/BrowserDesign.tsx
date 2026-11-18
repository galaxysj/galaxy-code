import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { MousePointerClick, PenLine, Undo2, X } from 'lucide-react'
import { addComment } from '../lib/comments'
import { CommentBox } from './CommentBox'
import { cn } from '../lib/utils'

type Point = { x: number; y: number }
interface Stroke { color: string; points: Point[] }

const COLORS = ['#0a84ff', '#ff3b30', '#ff9500', '#34c759', '#111111']
/** Pen width in the page picture's own pixels. */
const PEN_WIDTH = 8
/** Room around the drawing in the area a comment points at. */
const AREA_PADDING = 16

function drawStrokes(context: CanvasRenderingContext2D, strokes: Stroke[], scale: number): void {
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.lineWidth = PEN_WIDTH * scale
  for (const stroke of strokes) {
    context.strokeStyle = stroke.color
    context.beginPath()
    stroke.points.forEach((point, index) => index ? context.lineTo(point.x * scale, point.y * scale) : context.moveTo(point.x * scale, point.y * scale))
    if (stroke.points.length === 1) context.lineTo(stroke.points[0].x * scale + 0.1, stroke.points[0].y * scale)
    context.stroke()
  }
}

/**
 * Design mode over a still of the page: draw freely with a pen and write a note on the drawing, or switch to picking an element.
 * Each note becomes a composer comment carrying the page with the drawing on it.
 */
export function BrowserDesign({ frame, url, title, onPickElement, onClose }: { frame: string; url: string; title: string; onPickElement(): void; onClose(): void }): ReactNode {
  const image = useRef<HTMLImageElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [color, setColor] = useState(COLORS[0])
  const [note, setNote] = useState<Point | null>(null)
  const drawing = useRef<Stroke | null>(null)

  // Strokes are kept in the picture's own pixels, and drawn at the size the picture shows.
  const redraw = (extra?: Stroke): void => {
    const el = canvas.current
    const img = image.current
    if (!el || !img || !img.naturalWidth) return
    const box = img.getBoundingClientRect()
    const density = window.devicePixelRatio || 1
    el.width = Math.round(box.width * density)
    el.height = Math.round(box.height * density)
    const context = el.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, el.width, el.height)
    drawStrokes(context, extra ? [...strokes, extra] : strokes, (box.width * density) / img.naturalWidth)
  }
  useEffect(() => redraw(), [strokes, size])
  useEffect(() => {
    const img = image.current
    if (!img) return
    const observer = new ResizeObserver(() => setSize({ width: img.clientWidth, height: img.clientHeight }))
    observer.observe(img)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !note) onClose()
      if ((event.metaKey || event.ctrlKey) && event.key === 'z' && !note) setStrokes((list) => list.slice(0, -1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [note, onClose])

  const at = (event: { clientX: number; clientY: number }): Point | null => {
    const img = image.current
    if (!img || !img.naturalWidth) return null
    const box = img.getBoundingClientRect()
    return { x: ((event.clientX - box.left) / box.width) * img.naturalWidth, y: ((event.clientY - box.top) / box.height) * img.naturalHeight }
  }

  const down = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const point = at(event)
    if (!point || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drawing.current = { color, points: [point] }
    redraw(drawing.current)
  }
  const move = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const stroke = drawing.current
    const point = stroke && at(event)
    if (!stroke || !point) return
    stroke.points.push(point)
    redraw(stroke)
  }
  const up = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const stroke = drawing.current
    if (!stroke) return
    drawing.current = null
    setStrokes((list) => [...list, stroke])
    // The note box follows the latest stroke, and more strokes can go on the same note before it is written.
    setNote({ x: event.clientX, y: event.clientY + 10 })
  }

  /** The area a comment on these strokes points at, in the page picture's own pixels. */
  const areaOf = (img: HTMLImageElement): { x: number; y: number; width: number; height: number } => {
    const xs = strokes.flatMap((stroke) => stroke.points.map((point) => point.x))
    const ys = strokes.flatMap((stroke) => stroke.points.map((point) => point.y))
    const left = Math.max(0, Math.min(...xs) - AREA_PADDING)
    const top = Math.max(0, Math.min(...ys) - AREA_PADDING)
    return { x: left, y: top, width: Math.min(img.naturalWidth, Math.max(...xs) + AREA_PADDING) - left, height: Math.min(img.naturalHeight, Math.max(...ys) + AREA_PADDING) - top }
  }

  const submit = (text: string): void => {
    const img = image.current
    if (!img || !strokes.length) return
    const rect = areaOf(img)
    // The comment carries the page with the drawing on it, so the agent sees what was drawn.
    const composite = document.createElement('canvas')
    composite.width = img.naturalWidth
    composite.height = img.naturalHeight
    const context = composite.getContext('2d')
    if (!context) return
    context.drawImage(img, 0, 0)
    drawStrokes(context, strokes, 1)
    const src = composite.toDataURL('image/png')
    addComment({
      source: title || 'browser page',
      detail: `${url}; drawn with a pen in design mode; x ${Math.round(rect.x)}, y ${Math.round(rect.y)}, ${Math.round(rect.width)}x${Math.round(rect.height)} px of the ${img.naturalWidth}x${img.naturalHeight} page picture`,
      note: text,
      area: { group: `design:${url}:${src.length}:${src.slice(-64)}`, src, rect, reference: { width: img.naturalWidth, height: img.naturalHeight } }
    })
    setStrokes([])
  }

  // While the note is being written, the area it points at is shaded behind the drawing.
  const img = image.current
  const shade = note && strokes.length && img && img.naturalWidth
    ? (() => {
        const rect = areaOf(img)
        const sx = img.clientWidth / img.naturalWidth
        const sy = img.clientHeight / img.naturalHeight
        return { left: rect.x * sx, top: rect.y * sy, width: rect.width * sx, height: rect.height * sy }
      })()
    : null
  // The note box keeps off the drawing, in screen pixels.
  const avoid = shade && img ? (() => {
    const box = img.getBoundingClientRect()
    return { left: box.left + shade.left, top: box.top + shade.top, right: box.left + shade.left + shade.width, bottom: box.top + shade.top + shade.height }
  })() : undefined
  const tool = 'flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg'
  return (
    <div className="absolute inset-0">
      <img ref={image} src={frame} alt="" draggable={false} onLoad={() => setSize({ width: image.current?.clientWidth ?? 0, height: image.current?.clientHeight ?? 0 })} className="h-full w-full select-none" />
      {shade && <div className="pointer-events-none absolute rounded-sm shadow-[0_4px_16px_rgba(0,0,0,0.45)]" style={shade} />}
      <canvas ref={canvas} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} className="absolute inset-0 h-full w-full cursor-crosshair touch-none" />
      <div className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-line bg-elev p-1 shadow-lg">
        <button type="button" title="Pen" className={cn(tool, 'bg-hover text-fg')}><PenLine size={14} /></button>
        <button type="button" title="Select an element" onClick={onPickElement} className={tool}><MousePointerClick size={14} /></button>
        <span className="mx-1 h-4 w-px bg-line" />
        {COLORS.map((entry) => (
          <button key={entry} type="button" title="Pen color" onClick={() => setColor(entry)} className={cn('flex h-7 w-7 items-center justify-center rounded-md hover:bg-hover', color === entry && 'bg-hover')}>
            <span className={cn('h-3.5 w-3.5 rounded-full', color === entry && 'ring-2 ring-fg/40 ring-offset-1 ring-offset-elev')} style={{ background: entry }} />
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-line" />
        <button type="button" title="Undo the last stroke" disabled={!strokes.length} onClick={() => setStrokes((list) => list.slice(0, -1))} className={cn(tool, 'disabled:opacity-40')}><Undo2 size={14} /></button>
        <button type="button" title="Leave design mode" onClick={onClose} className={tool}><X size={14} /></button>
      </div>
      {note && strokes.length > 0 && (
        <CommentBox
          key={`${note.x},${note.y}`}
          x={note.x}
          y={note.y}
          avoid={avoid}
          within={img ? (() => { const box = img.getBoundingClientRect(); return { left: box.left, top: box.top, right: box.right, bottom: box.bottom } })() : undefined}
          title="Drawing"
          onClose={() => { setNote(null); setStrokes([]) }}
          onSubmit={(text) => { submit(text); setNote(null) }}
        />
      )}
    </div>
  )
}
