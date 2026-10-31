import { useEffect, useRef, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Editor, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, parserCtx, remarkStringifyOptionsCtx, rootCtx, serializerCtx } from '@milkdown/kit/core'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { history } from '@milkdown/kit/plugin/history'
import { trailing } from '@milkdown/kit/plugin/trailing'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { Plugin, TextSelection } from '@milkdown/kit/prose/state'
import { addRowAfter, isInTable, selectedRect } from '@milkdown/kit/prose/tables'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import type { EditorView, NodeView } from '@milkdown/kit/prose/view'
import type { Ctx } from '@milkdown/kit/ctx'
import { $prose } from '@milkdown/kit/utils'
import { codeHighlight } from '../lib/codeHighlight'
import { concealedDoc, revealMarks } from '../lib/revealMarks'
import { Markdown } from './Markdown'
import { linkedFile, openLink } from '../lib/openLink'
import { useStore } from '../store'

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/

/** Paired tags reach the editor one at a time, so a lone tag shows as source rather than as nothing. */
function htmlView(node: ProseNode): NodeView {
  const value = String(node.attrs.value).trim()
  const dom = document.createElement('span')
  dom.className = 'live-html'
  dom.contentEditable = 'false'
  if (/^<\/?[a-z][^>]*>$/i.test(value) && !/^<(?:img|br|hr)\b/i.test(value)) {
    dom.classList.add('live-html-tag')
    dom.textContent = value
    return { dom, ignoreMutation: () => true }
  }
  const root = createRoot(dom)
  root.render(<Markdown text={value} html />)
  return { dom, ignoreMutation: () => true, destroy: () => queueMicrotask(() => root.unmount()) }
}

/** A code block ends only by typing ``` on its last line and pressing Enter. */
function closeCodeBlock(view: EditorView): boolean {
  const { state } = view
  const { $from, empty } = state.selection
  if (!empty || $from.parent.type.name !== 'code_block') return false
  const code = $from.parent.textContent
  if ($from.parentOffset !== code.length || !/(?:^|\n)```$/.test(code)) return false
  const fence = code.endsWith('\n```') ? 4 : 3
  const tr = state.tr.delete($from.pos - fence, $from.pos)
  const after = tr.mapping.map($from.after())
  tr.insert(after, state.schema.nodes.paragraph.create())
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView())
  return true
}

/** Enter in a table adds a row below and moves to its first cell. */
function addTableRow(view: EditorView): boolean {
  if (!isInTable(view.state)) return false
  const row = selectedRect(view.state).bottom
  addRowAfter(view.state, view.dispatch)
  const { map, tableStart } = selectedRect(view.state)
  const cell = tableStart + map.map[row * map.width]
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(cell + 1))).scrollIntoView())
  return true
}

/**
 * Edits Markdown in place, with formatting applied as it is typed. Front matter stays out of the
 * editor as a read-only block. `initial` is read once, so remount with a new key to load new text.
 */
export function LiveMarkdown({ initial, onChange, onSave }: { initial: string; onChange(text: string): void; onSave(text: string): void }): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const latest = useRef({ onChange, onSave })
  latest.current = { onChange, onSave }
  const frontmatter = initial.match(FRONTMATTER)?.[0] ?? ''

  useEffect(() => {
    const root = host.current
    if (!root) return
    // Loading tidies the text, which is not an edit; the baseline is what the editor would save.
    let last = ''
    const markdownOf = (ctx: Ctx): string => frontmatter + ctx.get(serializerCtx)(concealedDoc(ctx.get(editorViewCtx).state))
    const made = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root)
        ctx.set(defaultValueCtx, initial.slice(frontmatter.length))
        ctx.update(remarkStringifyOptionsCtx, (options) => ({ ...options, bullet: '-' as const }))
        ctx.update(editorViewOptionsCtx, (options) => ({
          ...options,
          attributes: { class: 'md selectable live-md' },
          handleKeyDown: (view, event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 's') {
              event.preventDefault()
              // Change events are debounced, so read the document itself.
              latest.current.onSave(markdownOf(ctx))
              return true
            }
            if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey) return false
            return closeCodeBlock(view) || addTableRow(view)
          },
          handleDOMEvents: {
            // A click opens the link; the arrow keys are how to edit one.
            click: (_view, event) => {
              const link = (event.target as HTMLElement).closest('a')
              if (!link) return false
              event.preventDefault()
              if (/^https?:/i.test(link.href)) void openLink(link.href, event)
              else {
                // This editor knows no folder, so a relative link has nothing to resolve against.
                const file = linkedFile(link.getAttribute('href') ?? '')
                if (file && /^[/~]/.test(file.path)) useStore.getState().openFile(file.path, file.line)
              }
              return true
            }
          }
        }))
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(clipboard)
      .use(trailing)
      .use($prose(codeHighlight))
      .use($prose((ctx) => new Plugin({
        // Reports every edit at once, so the source view always has the latest text.
        view: () => ({
          update: (view, previous) => {
            if (view.state.doc === previous.doc) return
            const markdown = markdownOf(ctx)
            if (markdown === last) return
            last = markdown
            latest.current.onChange(markdown)
          }
        })
      })))
      .use($prose((ctx) => revealMarks({
        htmlView,
        parseTable: (markdown) => {
          const parsed = ctx.get(parserCtx)(markdown).firstChild
          return parsed?.type.name === 'table' ? parsed : null
        }
      })))
      .create()
    void made.then((editor) => editor.action((ctx) => {
      last = markdownOf(ctx)
    }))
    return () => void made.then((editor) => editor.destroy())
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="min-h-0 flex-1 cursor-text overflow-y-auto px-5 py-4">
      {frontmatter && (
        <pre className="mb-3 cursor-default overflow-x-auto rounded-lg border border-line bg-inset px-3 py-2 font-mono text-[11.5px] leading-relaxed text-muted">
          {frontmatter.replace(/^---\r?\n/, '').replace(/\r?\n---\s*$/, '')}
        </pre>
      )}
      <div ref={host} />
    </div>
  )
}
