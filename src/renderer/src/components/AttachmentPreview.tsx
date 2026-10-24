import { X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Attachment } from '@shared/types'
import { useStore } from '../store'
import { IconButton, Modal, Spinner } from './ui'

export function AttachmentPreview({ file }: { file: Attachment }): ReactNode {
  const [source, setSource] = useState(file.preview ?? '')
  const [error, setError] = useState('')
  const viewport = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; x: number; y: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const close = useCallback(() => useStore.setState({ attachmentPreview: null }), [])
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const zoom = (event: WheelEvent): void => {
      if (!event.metaKey) return
      event.preventDefault()
      event.stopPropagation()
      const rect = element.getBoundingClientRect()
      const x = event.clientX - rect.left - rect.width / 2
      const y = event.clientY - rect.top - rect.height / 2
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1)
      setView((previous) => {
        const scale = Math.max(0.1, Math.min(10, previous.scale * Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.01)))
        const ratio = scale / previous.scale
        return { scale, x: x - (x - previous.x) * ratio, y: y - (y - previous.y) * ratio }
      })
    }
    element.addEventListener('wheel', zoom, { passive: false })
    return () => element.removeEventListener('wheel', zoom)
  }, [])
  useEffect(() => {
    let current = true
    void window.galaxy.files.read(file.path).then((view) => {
      if (!current) return
      if (view.kind === 'image' && view.dataUrl) setSource(view.dataUrl)
      else if (!file.preview) setError('This image could not be previewed.')
    }).catch(() => {
      if (current && !file.preview) setError('Could not load this image.')
    })
    return () => { current = false }
  }, [file.path, file.preview])

  return (
    <Modal onClose={close} className="flex max-w-full flex-col">
      <div role="dialog" aria-modal="true" aria-label={`Preview ${file.name}`}>
        <div className="flex items-center gap-4 border-b border-line px-4 py-2.5">
          <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{file.name}</span>
          <button type="button" title="Reset zoom and position" onClick={() => setView({ scale: 1, x: 0, y: 0 })} className="shrink-0 text-[12px] tabular-nums text-muted">{Math.round(view.scale * 100)}% · Reset</button>
          <IconButton autoFocus label="Close preview" onClick={close}><X size={16} /></IconButton>
        </div>
        <div
          ref={viewport}
          className="relative flex h-[min(760px,calc(100vh-160px))] w-[min(1100px,calc(100vw-104px))] touch-none select-none items-center justify-center overflow-hidden bg-inset"
          style={{ cursor: source && !error ? dragging ? 'grabbing' : 'grab' : 'default' }}
          title="Command + scroll to zoom. Drag to move."
          onPointerDown={(event) => {
            if (event.button !== 0 || !source || error) return
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
            setDragging(true)
          }}
          onPointerMove={(event) => {
            const previous = drag.current
            if (!previous || previous.id !== event.pointerId) return
            const dx = event.clientX - previous.x
            const dy = event.clientY - previous.y
            drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
            setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }))
          }}
          onPointerUp={(event) => {
            if (drag.current?.id !== event.pointerId) return
            drag.current = null
            setDragging(false)
            event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onPointerCancel={() => { drag.current = null; setDragging(false) }}
          onLostPointerCapture={() => { drag.current = null; setDragging(false) }}
        >
          {error ? <p className="p-6 text-[13px] text-muted">{error}</p> : source ? (
            <img src={source} alt={file.name} draggable={false} className="pointer-events-none block max-h-full max-w-full object-contain p-3" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }} onError={() => setError('Could not display this image.')} />
          ) : <Spinner size={24} />}
        </div>
      </div>
    </Modal>
  )
}
