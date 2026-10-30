import type { Node as ProseNode, ResolvedPos } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type NodeView } from '@milkdown/kit/prose/view'
import type { EditorView } from '@milkdown/kit/prose/view'

/** The Markdown written around each mark that shows as soon as the caret touches it. */
const SYNTAX: Record<string, string> = { strong: '**', emphasis: '*', strike_through: '~~', inlineCode: '`' }
/** Inline nodes that turn back into their Markdown only when reached with the arrow keys. */
const ATOMS = ['image', 'html']
const LINK = /^\[([^\]]*)\]\(([^)\s]*)(?:\s+"([^"]*)")?\)$/
const IMAGE = /^!\[([^\]]*)\]\(([^)\s]*)(?:\s+"([^"]*)")?\)$/

/** What is showing as raw Markdown: a mark's name, 'link', 'image', 'html' or 'heading'. */
interface Revealed {
  from: number
  to: number
  kind: string
}

const key = new PluginKey<Revealed | null>('reveal-marks')

/** The run of text around a position that carries the given kinds of mark. */
function markRun($pos: ResolvedPos, kinds: string[]): Revealed | null {
  const touching = [$pos.nodeBefore, $pos.nodeAfter].flatMap((node) => node?.marks ?? []).find((mark) => kinds.includes(mark.type.name))
  if (!touching) return null
  const start = $pos.start()
  const runs: { from: number; to: number; on: boolean }[] = []
  $pos.parent.forEach((child: ProseNode, offset) => {
    runs.push({ from: start + offset, to: start + offset + child.nodeSize, on: touching.isInSet(child.marks) })
  })
  const at = runs.findIndex((run) => run.on && run.from <= $pos.pos && $pos.pos <= run.to)
  if (at < 0) return null
  let first = at
  let last = at
  while (first > 0 && runs[first - 1].on) first--
  while (last < runs.length - 1 && runs[last + 1].on) last++
  return { from: runs[first].from, to: runs[last].to, kind: touching.type.name }
}

/** What the caret should reveal here. Links, images and HTML wait for the arrow keys, so a click can open them. */
function targetAt($pos: ResolvedPos, byArrow: boolean): Revealed | null {
  if (!$pos.parent.isTextblock || $pos.parent.type.spec.code) return null
  if ($pos.parent.type.name === 'heading' && $pos.parentOffset === 0) return { from: $pos.pos, to: $pos.pos, kind: 'heading' }
  if (byArrow) {
    const { nodeBefore: before, nodeAfter: after } = $pos
    if (before && ATOMS.includes(before.type.name)) return { from: $pos.pos - before.nodeSize, to: $pos.pos, kind: before.type.name }
    if (after && ATOMS.includes(after.type.name)) return { from: $pos.pos, to: $pos.pos + after.nodeSize, kind: after.type.name }
  }
  return markRun($pos, byArrow ? [...Object.keys(SYNTAX), 'link'] : Object.keys(SYNTAX))
}

function destination(src: string, title: string | null | undefined, alt = ''): string {
  return title && title !== alt ? `(${src} "${title}")` : `(${src})`
}

/** Puts the Markdown into the text, so it can be edited like any other character. */
function reveal(tr: Transaction, range: Revealed): Revealed {
  const { from, to, kind } = range
  const { schema } = tr.doc.type
  const head = tr.selection.head
  let end = to
  let open = 0
  if (kind === 'heading') {
    const prefix = `${'#'.repeat(tr.doc.resolve(from).parent.attrs.level as number)} `
    tr.insertText(prefix, from)
    end = from + prefix.length
  } else if (kind === 'image' || kind === 'html') {
    const node = tr.doc.nodeAt(from)!
    const { src, alt, title, value } = node.attrs as Record<string, string>
    const text = kind === 'html' ? value : `![${alt}]${destination(src, title, alt)}`
    tr.replaceWith(from, to, schema.text(text))
    end = from + text.length
  } else if (kind === 'link') {
    const mark = tr.doc.nodeAt(from)!.marks.find((entry) => entry.type.name === 'link')!
    const close = `]${destination(mark.attrs.href as string, mark.attrs.title as string | null)}`
    tr.removeMark(from, to, schema.marks.link)
    tr.insertText(close, to)
    tr.insertText('[', from)
    open = 1
    end = to + 1 + close.length
  } else {
    const syntax = SYNTAX[kind]
    tr.removeMark(from, to, schema.marks[kind])
    tr.insertText(syntax, to)
    tr.insertText(syntax, from)
    open = syntax.length
    end = to + syntax.length * 2
  }
  // A caret on the edge stays outside the syntax, and one inside moves with its letter.
  tr.setSelection(TextSelection.create(tr.doc, head === from ? from : head === to ? end : head + open))
  return { from, to: end, kind }
}

/** Turns revealed Markdown back into what it says. Syntax the user broke stays as plain text. */
function conceal(tr: Transaction, range: Revealed): void {
  const { from, to, kind } = range
  const { schema } = tr.doc.type
  const $from = tr.doc.resolve(from)
  if (!$from.parent.isTextblock || $from.parent !== tr.doc.resolve(to).parent) return
  const text = tr.doc.textBetween(from, to, undefined, '￼')
  if (kind === 'heading') {
    if ($from.parent.type.name !== 'heading') return
    const prefix = $from.parent.textContent.match(/^(#{1,6})[ \t]+/)
    const before = $from.before()
    if (prefix) {
      tr.delete($from.start(), $from.start() + prefix[0].length)
      tr.setNodeMarkup(before, undefined, { ...$from.parent.attrs, level: prefix[1].length })
    } else tr.setNodeMarkup(before, schema.nodes.paragraph)
  } else if (kind === 'image') {
    const match = text.match(IMAGE)
    if (match) tr.replaceWith(from, to, schema.nodes.image.create({ alt: match[1], src: match[2], title: match[3] ?? '' }))
  } else if (kind === 'html') {
    if (text.trim()) tr.replaceWith(from, to, schema.nodes.html.create({ value: text }))
  } else if (kind === 'link') {
    const match = text.match(LINK)
    if (match?.[1]) tr.replaceWith(from, to, schema.text(match[1], [schema.marks.link.create({ href: match[2], title: match[3] ?? null })]))
  } else {
    const syntax = SYNTAX[kind]
    const open = text.indexOf(syntax)
    const close = text.lastIndexOf(syntax)
    if (open < 0 || close - open - syntax.length < 1) return
    const start = from + open
    const end = from + close
    tr.delete(end, end + syntax.length)
    tr.delete(start, start + syntax.length)
    tr.addMark(start, end - syntax.length, schema.marks[kind].create())
  }
}

const INLINE_RULES: { kind: string; pattern: RegExp }[] = [
  { kind: 'inlineCode', pattern: /`([^`\n]+)`/g },
  { kind: 'image', pattern: /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g },
  { kind: 'link', pattern: /(?<!!)\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g },
  { kind: 'autolink', pattern: /(?<![\w([<"'=/.-])(?:https?:\/\/|www\.)[^\s<]+(?=\s)/g },
  { kind: 'strong', pattern: /(?<!\*)\*\*(?=\S)(.+?)(?<=\S)\*\*(?!\*)/g },
  { kind: 'strike_through', pattern: /~~(?=\S)(.+?)(?<=\S)~~/g },
  { kind: 'emphasis', pattern: /(?<![*\w])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![*\w])/g }
]

/** Applies the first finished piece of syntax in a block's text. The input rules only see syntax finished from left to right. */
function applyInline(tr: Transaction, start: number, end: number, skip: Revealed | null): boolean {
  const { schema } = tr.doc.type
  let text = tr.doc.textBetween(start, end, undefined, '\ufffc')
  if (skip) {
    const from = Math.max(skip.from - start, 0)
    const to = Math.min(skip.to - start, text.length)
    if (from < to) text = text.slice(0, from) + ' '.repeat(to - from) + text.slice(to)
  }
  for (const { kind, pattern } of INLINE_RULES) {
    for (const match of text.matchAll(pattern)) {
      const from = start + match.index
      const to = from + match[0].length
      if (tr.doc.rangeHasMark(from, to, schema.marks.inlineCode) || tr.doc.rangeHasMark(from, to, schema.marks.link)) continue
      if (kind === 'autolink') {
        // GFM leaves sentence punctuation out of a bare link.
        const url = match[0].replace(/[.,:;!?)*_~'"]+$/, '')
        tr.addMark(from, from + url.length, schema.marks.link.create({ href: url.startsWith('www.') ? `http://${url}` : url, title: null }))
        return true
      }
      if (kind === 'image') {
        tr.replaceWith(from, to, schema.nodes.image.create({ alt: match[1], src: match[2], title: match[3] ?? '' }))
        return true
      }
      const open = kind === 'link' ? 1 : SYNTAX[kind].length
      const close = kind === 'link' ? match[0].length - 1 - match[1].length : open
      const mark = kind === 'link' ? schema.marks.link.create({ href: match[2], title: match[3] ?? null }) : schema.marks[kind].create()
      tr.addMark(from + open, to - close, mark)
      tr.delete(to - close, to)
      tr.delete(from, from + open)
      return true
    }
  }
  return false
}

/** Finishes syntax in the caret's block, however it was typed. Returns whether anything changed. */
function applySyntax(tr: Transaction, skip: Revealed | null): boolean {
  const { $head } = tr.selection
  const { parent } = $head
  if (!parent.isTextblock || parent.type.spec.code) return false
  let changed = false
  const prefix = parent.type.name === 'paragraph' ? parent.textContent.match(/^(#{1,6})[ \t]+\S/) : null
  if (prefix && !skip) {
    const size = prefix[1].length + 1
    tr.delete($head.start(), $head.start() + size)
    tr.setNodeMarkup($head.before(), tr.doc.type.schema.nodes.heading, { level: prefix[1].length })
    changed = true
  }
  for (let turn = 0; turn < 20; turn++) {
    const $now = tr.selection.$head
    const range = skip && { ...skip, from: tr.mapping.map(skip.from, -1), to: tr.mapping.map(skip.to, 1) }
    if (!applyInline(tr, $now.start(), $now.end(), range)) break
    changed = true
  }
  return changed
}

const cellCount = (row: string): number => row.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).length

/** Turns a typed GFM header row and delimiter row into a table, with one empty row to fill in. */
function applyTable(tr: Transaction, parseTable: (markdown: string) => ProseNode | null): boolean {
  const { $head } = tr.selection
  if ($head.parent.type.name !== 'paragraph' || $head.depth < 1) return false
  const delimiter = $head.parent.textContent
  if (!delimiter.includes('|') || !/^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/.test(delimiter)) return false
  const index = $head.index($head.depth - 1)
  const header = index > 0 ? $head.node($head.depth - 1).child(index - 1) : null
  if (header?.type.name !== 'paragraph' || !header.textContent.includes('|')) return false
  const columns = cellCount(delimiter)
  if (cellCount(header.textContent) !== columns) return false
  const table = parseTable(`${header.textContent}\n${delimiter}\n|${' |'.repeat(columns)}`)
  if (!table) return false
  const from = $head.before() - header.nodeSize
  tr.replaceWith(from, $head.after(), table)
  const firstCell = from + table.nodeSize - 1 - table.lastChild!.nodeSize + 3
  tr.setSelection(TextSelection.near(tr.doc.resolve(firstCell)))
  return true
}

/** The document as it should be saved: any revealed Markdown back in its final form. */
export function concealedDoc(state: EditorState): ProseNode {
  const range = key.getState(state)
  if (!range) return state.doc
  const tr = state.tr
  conceal(tr, range)
  return tr.doc
}

/** Revealed bold stays bold and so on, with its syntax as plain text. */
function decorate(state: EditorState): DecorationSet | null {
  const range = key.getState(state)
  const syntax = range && SYNTAX[range.kind]
  if (!range || !syntax) return null
  const { from, to, kind } = range
  const length = syntax.length
  if (to - from <= length * 2 || state.doc.textBetween(from, from + length, undefined, '￼') !== syntax) return null
  return DecorationSet.create(state.doc, [
    Decoration.inline(from + length, to - length, { class: `live-${kind}` })
  ])
}

/** Shows Markdown syntax as text when the caret reaches it, and renders it again when the caret leaves. */
export function revealMarks({ htmlView, parseTable }: { htmlView?: (node: ProseNode) => NodeView; parseTable?: (markdown: string) => ProseNode | null } = {}): Plugin {
  let editor: EditorView | null = null
  let byArrow = false
  return new Plugin<Revealed | null>({
    key,
    view(view) {
      editor = view
      return {}
    },
    state: {
      init: () => null,
      apply(tr, value) {
        const next = tr.getMeta(key) as { range: Revealed | null } | undefined
        if (next) return next.range
        return value && { ...value, from: tr.mapping.map(value.from, -1), to: tr.mapping.map(value.to, 1) }
      }
    },
    props: {
      decorations: decorate,
      nodeViews: htmlView ? { html: htmlView } : {},
      // A task item's box is drawn on the item itself, so only a click on the item lands on it.
      handleClickOn(view, _pos, node, position, event) {
        if (node.type.name !== 'list_item' || node.attrs.checked == null || event.target !== view.nodeDOM(position)) return false
        view.dispatch(view.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, checked: !node.attrs.checked }))
        return true
      },
      handleKeyDown(_view, event) {
        byArrow = event.key.startsWith('Arrow')
        return false
      },
      handleDOMEvents: {
        mousedown() {
          byArrow = false
          return false
        }
      }
    },
    appendTransaction(transactions, _old, state) {
      // Moving text during IME composition would break the word being composed.
      if (editor?.composing || !transactions.some((tr) => tr.selectionSet || tr.docChanged)) return null
      const current = key.getState(state)
      const tr = state.tr.setMeta('addToHistory', false)
      const edited = transactions.some((entry) => entry.docChanged) && state.selection.empty
      const applied = edited && (!!parseTable && !current && applyTable(tr, parseTable) || applySyntax(tr, current ?? null))
      const range = current && { ...current, from: tr.mapping.map(current.from, -1), to: tr.mapping.map(current.to, 1) }
      const { empty, head } = tr.selection
      if (range && empty && range.from <= head && head <= range.to) return applied ? tr.setMeta(key, { range }) : null
      if (range) conceal(tr, range)
      const target = tr.selection.empty ? targetAt(tr.selection.$head, byArrow) : null
      if (!applied && !range && !target) return null
      tr.setMeta(key, { range: target ? reveal(tr, target) : null })
      return tr
    }
  })
}
