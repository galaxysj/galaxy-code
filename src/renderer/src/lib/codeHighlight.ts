import hljs from 'highlight.js/lib/common'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'

const key = new PluginKey<DecorationSet>('code-highlight')

/** Reads highlight.js's spans as text ranges, so they can decorate the editable text in place. */
function ranges(node: Node, offset: number, out: { from: number; to: number; className: string }[]): number {
  let at = offset
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) at += child.textContent?.length ?? 0
    else {
      const start = at
      at = ranges(child, at, out)
      out.push({ from: start, to: at, className: (child as Element).className })
    }
  }
  return at
}

function decorate(doc: ProseNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, position) => {
    if (node.type.name !== 'code_block') return true
    const language = String(node.attrs.language ?? '')
    if (!node.textContent || !hljs.getLanguage(language)) return false
    const html = hljs.highlight(node.textContent, { language, ignoreIllegals: true }).value
    const parsed = new DOMParser().parseFromString(html, 'text/html').body
    const found: { from: number; to: number; className: string }[] = []
    ranges(parsed, 0, found)
    const start = position + 1
    for (const { from, to, className } of found) {
      if (from < to) decorations.push(Decoration.inline(start + from, start + to, { class: className }))
    }
    return false
  })
  return DecorationSet.create(doc, decorations)
}

/** Colors code blocks with the same highlighter and theme as chat. */
export function codeHighlight(): Plugin {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_config, state) => decorate(state.doc),
      apply: (tr, value) => (tr.docChanged ? decorate(tr.doc) : value)
    },
    props: {
      decorations: (state) => key.getState(state)
    }
  })
}
