import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { BrowserPick } from '@shared/types'
import { addComment } from '../lib/comments'
import { CommentBox } from './CommentBox'
import { usePopoverShown } from './ui'

/** A file path as a file:// URL, each part encoded. */
const fileUrl = (path: string): string => `file://${path.split('/').map(encodeURIComponent).join('/')}`

/**
 * The body of a Visual View: the page runs in the app's own Chromium view, laid over this placeholder, while the
 * artifact's header and buttons stay the app's. Comments are the Visual View's own: while `picking` is on, a click picks
 * an element and a drag picks an area, one comment after another, each carrying a picture of the page.
 */
export function VisualViewBody({ path, name, visible, reloadKey, picking, onPickingChange, covered }: {
  path: string
  name: string
  visible: boolean
  /** Changes when the page should load again. */
  reloadKey: string
  picking: boolean
  onPickingChange(on: boolean): void
  /** Something of the app's sits over the page, such as a note box from the header. */
  covered: boolean
}): ReactNode {
  // Prefixed "preview:" so the agent's browser never lists or drives it.
  const tabId = `preview:visual:${path}`
  const host = useRef<HTMLDivElement>(null)
  const popover = usePopoverShown()
  const [still, setStill] = useState<string | null>(null)
  const [picked, setPicked] = useState<{ pick: BrowserPick; frame: string } | null>(null)
  const over = covered || popover

  // A still of the page stands in for it while something of the app's has to sit above the native view.
  useEffect(() => {
    if (!over || !visible) {
      setStill(null)
      return
    }
    let alive = true
    void window.galaxy.browser.frame(tabId).then((image) => { if (alive) setStill(image) }).catch(() => {})
    return () => { alive = false }
  }, [over, visible, tabId])
  const stepAside = !visible || !!picked || (over && !!still)

  const sync = useCallback(() => {
    const el = host.current
    if (!el || stepAside) {
      void window.galaxy.browser.setBounds(null, tabId)
      return
    }
    const rect = el.getBoundingClientRect()
    void window.galaxy.browser.setBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }, tabId)
  }, [stepAside, tabId])
  useLayoutEffect(() => {
    sync()
    const el = host.current
    if (!el) return
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    window.addEventListener('resize', sync)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [sync])

  useEffect(() => {
    void window.galaxy.browser.navigate(fileUrl(path), tabId).catch(() => {})
  }, [path, reloadKey, tabId])
  // The view goes with the tab or the switch to source.
  useEffect(() => () => {
    void window.galaxy.browser.cancelPick(tabId)
    void window.galaxy.browser.setBounds(null, tabId)
    void window.galaxy.browser.close(tabId)
  }, [tabId])

  // Continuous Comment: pick, write the note, and pick again until it is turned off.
  useEffect(() => {
    if (!picking || picked || !visible) return
    let alive = true
    void window.galaxy.browser.pick(tabId).then(async (pick) => {
      if (!alive) return
      if (!pick) {
        onPickingChange(false)
        return
      }
      const frame = await window.galaxy.browser.frame(tabId)
      if (alive && frame) setPicked({ pick, frame })
    }).catch(() => { if (alive) onPickingChange(false) })
    return () => {
      alive = false
      void window.galaxy.browser.cancelPick(tabId)
    }
  }, [picking, picked, visible, tabId])
  useEffect(() => { if (!picking) setPicked(null) }, [picking])

  const box = host.current?.getBoundingClientRect()
  const scale = picked && box ? { x: box.width / picked.pick.viewport.width, y: box.height / picked.pick.viewport.height } : null
  const mark = picked && scale ? { left: picked.pick.rect.x * scale.x, top: picked.pick.rect.y * scale.y, width: picked.pick.rect.width * scale.x, height: picked.pick.rect.height * scale.y } : null
  const shown = picked?.frame ?? (over ? still : null)

  return (
    <div ref={host} className="relative h-full w-full overflow-hidden bg-white">
      {shown && <img src={shown} alt="" draggable={false} className="h-full w-full select-none" />}
      {mark && <div className="pointer-events-none absolute border-2 border-[#0a84ff] bg-[#0a84ff]/30" style={mark} />}
      {picked && mark && box && (
        <CommentBox
          x={box.left + mark.left}
          y={box.top + mark.top + mark.height + 10}
          avoid={{ left: box.left + mark.left, top: box.top + mark.top, right: box.left + mark.left + mark.width, bottom: box.top + mark.top + mark.height }}
          within={{ left: box.left, top: box.top, right: box.right, bottom: box.bottom }}
          title={name}
          onClose={() => setPicked(null)}
          onSubmit={(note) => {
            const { pick, frame } = picked
            const element = pick.element
            const detail = [pick.kind === 'element' ? 'element' : 'dragged area', element ? `selector ${element.selector}` : '', `x ${Math.round(pick.rect.x)}, y ${Math.round(pick.rect.y)}, ${Math.round(pick.rect.width)}x${Math.round(pick.rect.height)} px of a ${pick.viewport.width}x${pick.viewport.height} view`].filter(Boolean).join('; ')
            addComment({ source: name, detail, quote: element?.text || element?.html, note, area: { group: `visual:${path}:${frame.length}:${frame.slice(-64)}`, src: frame, rect: pick.rect, reference: pick.viewport } })
          }}
        />
      )}
    </div>
  )
}
