import { useStore } from '../store'

/** Starts the comment list at the end of a sent message. The timeline hides everything from here and shows a card instead. */
export const COMMENTS_MARKER = 'Comments on the work, each numbered.'

export interface CommentArea {
  /** What the picture is: the same group is drawn on one picture, with every area numbered. */
  group: string
  /** The picture as a data URL. */
  src: string
  rect: { x: number; y: number; width: number; height: number }
  /** The pixels `rect` is measured in; the picture scales to them. */
  reference: { width: number; height: number }
}

export interface ComposerComment {
  id: string
  /** What the comment is about: a file name, "Screenshot", a page title. */
  source: string
  /** Extra place information, such as "lines 4-6", a URL or an element selector. */
  detail?: string
  /** The text, element or area the comment points at. */
  quote?: string
  note: string
  area?: CommentArea
}

/** Adds a comment to the message being written. It waits as a card above the input until the message is sent. */
export function addComment(input: Omit<ComposerComment, 'id'>, range?: Range): void {
  const state = useStore.getState()
  const id = crypto.randomUUID()
  if (range) marks.set(id, range)
  state.addComposerComment(state.activeChatId ?? 'new', { ...input, id })
  paintMarks()
}

// Commented text stays marked in dark blue while its comment waits in the message. `pending` is the selection a note box is open for.
const marks = new Map<string, Range>()
const paint = (): void => {
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
  const Highlight = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight
  if (!registry || !Highlight) return
  const ranges = [...marks.values()].filter((range) => !range.collapsed)
  if (ranges.length) registry.set('comment-mark', new Highlight(...ranges))
  else registry.delete('comment-mark')
}
export function paintMarks(): void {
  const live = new Set(Object.values(useStore.getState().composerComments).flat().map((comment) => comment.id))
  for (const id of [...marks.keys()]) if (id !== 'pending' && !live.has(id)) marks.delete(id)
  paint()
}
export function markPending(range: Range | null): void {
  if (range) marks.set('pending', range)
  else marks.delete('pending')
  paint()
}
useStore.subscribe(paintMarks)

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('The picture could not be read.'))
    img.src = src
  })
}

/** The picture with every commented area outlined and numbered. */
export async function outlineAreas(src: string, areas: { n: number; rect: CommentArea['rect']; reference: CommentArea['reference'] }[]): Promise<string> {
  const img = await load(src)
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return src
  ctx.drawImage(img, 0, 0)
  const line = Math.max(3, Math.round(img.naturalWidth / 300))
  const badge = Math.max(18, Math.round(img.naturalWidth / 45))
  for (const { n, rect, reference } of areas) {
    const sx = img.naturalWidth / reference.width
    const sy = img.naturalHeight / reference.height
    const x = rect.x * sx
    const y = rect.y * sy
    ctx.lineWidth = line
    // Only a border, so what it marks, such as a drawing, shows as it is.
    ctx.strokeStyle = '#0a84ff'
    ctx.strokeRect(x, y, rect.width * sx, rect.height * sy)
    // The number sits on the top left corner, inside the picture.
    const bx = Math.max(0, Math.min(x, img.naturalWidth - badge))
    const by = Math.max(0, Math.min(y - badge, img.naturalHeight - badge))
    ctx.fillStyle = '#0a84ff'
    ctx.fillRect(bx, by, badge, badge)
    ctx.fillStyle = '#ffffff'
    ctx.font = `bold ${Math.round(badge * 0.7)}px -apple-system, system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(n), bx + badge / 2, by + badge / 2 + 1)
  }
  return canvas.toDataURL('image/png')
}

/** A small grayscale copy of a picture, for telling whether two screenshots show the same screen. */
async function fingerprint(src: string): Promise<{ thumb: Uint8ClampedArray; ratio: number } | null> {
  try {
    const img = await load(src)
    const size = 48
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, size, size)
    const data = ctx.getImageData(0, 0, size, size).data
    const thumb = new Uint8ClampedArray(size * size)
    for (let i = 0; i < thumb.length; i++) thumb[i] = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3
    return { thumb, ratio: img.naturalWidth / img.naturalHeight }
  } catch {
    return null
  }
}

function difference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let total = 0
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i])
  return total / a.length
}

/** The comments as text for the prompt, and the pictures they point at, each with its areas numbered as in the text. */
export async function buildComments(comments: ComposerComment[]): Promise<{ text: string; images: { name: string; dataUrl: string }[] }> {
  const groups = new Map<string, { src: string; areas: { n: number; rect: CommentArea['rect']; reference: CommentArea['reference'] }[] }>()
  comments.forEach((comment, index) => {
    const area = comment.area
    if (!area) return
    const group = groups.get(area.group) ?? { src: area.src, areas: [] }
    group.areas.push({ n: index + 1, rect: area.rect, reference: area.reference })
    groups.set(area.group, group)
  })
  // Screenshots of the same screen are never byte-identical (a fresh capture each time), so ones that look alike share one picture.
  const merged: { src: string; thumb: Uint8ClampedArray | null; ratio: number; areas: { n: number; rect: CommentArea['rect']; reference: CommentArea['reference'] }[]; keys: string[] }[] = []
  for (const [group, { src, areas }] of groups) {
    const look = await fingerprint(src)
    const same = merged.find((item) => look && item.thumb && Math.abs(item.ratio - look.ratio) < 0.01 && difference(item.thumb, look.thumb) < 6)
    if (same) {
      same.areas.push(...areas)
      same.keys.push(group)
    } else merged.push({ src, thumb: look?.thumb ?? null, ratio: look?.ratio ?? 0, areas: [...areas], keys: [group] })
  }
  const images: { name: string; dataUrl: string }[] = []
  const names = new Map<string, number>()
  for (const [index, item] of merged.entries()) {
    for (const key of item.keys) names.set(key, index + 1)
    images.push({ name: `comments-picture-${index + 1}.png`, dataUrl: await outlineAreas(item.src, item.areas.sort((a, b) => a.n - b.n)) })
  }
  const lines = comments.map((comment, index) => {
    const clip = comment.quote ? comment.quote.replace(/\s+/g, ' ').slice(0, 300) : ''
    const place = [comment.detail, comment.area ? `marked ${index + 1} in attached picture ${names.get(comment.area.group)}` : ''].filter(Boolean).join('; ')
    return `${index + 1}. ${comment.source}${place ? ` (${place})` : ''}${clip ? `, "${clip}"` : ''}: ${comment.note.trim()}`
  })
  return { text: `${COMMENTS_MARKER} Numbers in attached pictures match them:\n${lines.join('\n')}`, images }
}

/** Has the message box send what it holds, comments included. */
export function requestSend(): void {
  const state = useStore.getState()
  useStore.setState({ composerSend: state.activeChatId ?? 'new' })
}
