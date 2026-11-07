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
export function addComment(input: Omit<ComposerComment, 'id'>): void {
  const state = useStore.getState()
  state.addComposerComment(state.activeChatId ?? 'new', { ...input, id: crypto.randomUUID() })
}

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
    ctx.strokeStyle = '#ff3b30'
    ctx.fillStyle = 'rgba(255,59,48,0.12)'
    ctx.fillRect(x, y, rect.width * sx, rect.height * sy)
    ctx.strokeRect(x, y, rect.width * sx, rect.height * sy)
    // The number sits on the top left corner, inside the picture.
    const bx = Math.max(0, Math.min(x, img.naturalWidth - badge))
    const by = Math.max(0, Math.min(y - badge, img.naturalHeight - badge))
    ctx.fillStyle = '#ff3b30'
    ctx.fillRect(bx, by, badge, badge)
    ctx.fillStyle = '#ffffff'
    ctx.font = `bold ${Math.round(badge * 0.7)}px -apple-system, system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(n), bx + badge / 2, by + badge / 2 + 1)
  }
  return canvas.toDataURL('image/png')
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
  const images: { name: string; dataUrl: string }[] = []
  let picture = 0
  const names = new Map<string, number>()
  for (const [group, { src, areas }] of groups) {
    picture += 1
    names.set(group, picture)
    images.push({ name: `comments-picture-${picture}.png`, dataUrl: await outlineAreas(src, areas) })
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
