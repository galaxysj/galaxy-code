import hljs from 'highlight.js/lib/common'
import { memo, useMemo, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components, type Options } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { cn, languageForPath } from '../lib/utils'
import { useStore } from '../store'
import { CopyButton } from './ui'
import { linkedFile, openLink } from '../lib/openLink'

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: ReactNode } }).props.children)
  return ''
}

/** Looks like `src/app.ts`, `./lib/x.py:12` or `/abs/path/file.md`. */
const FILE_REF = /^(~|\.{0,2})?\/?[\w@.+-]+(\/[\w@.+-]+)*\.[A-Za-z][\w]{0,7}(:\d+(-\d+)?)?$/

function fileReference(text: string): { path: string; line?: number } | null {
  if (text.length > 200 || !FILE_REF.test(text)) return null
  if (!text.includes('/') && !languageForPath(text.replace(/:\d+(-\d+)?$/, ''))) return null
  const match = text.match(/^(.*?)(?::(\d+)(?:-\d+)?)?$/)
  if (!match) return null
  return { path: match[1], line: match[2] ? Number(match[2]) : undefined }
}

export function CodeBlock({ code, language, className }: { code: string; language?: string | null; className?: string }): ReactNode {
  const html = useMemo(() => {
    if (language && hljs.getLanguage(language)) {
      try {
        return hljs.highlight(code, { language, ignoreIllegals: true }).value
      } catch {
        return null
      }
    }
    return null
  }, [code, language])
  return (
    <pre className={cn('selectable overflow-x-auto font-mono text-[12px] leading-[1.55]', className)}>
      {html !== null ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
    </pre>
  )
}

function Pre({ children }: { children?: ReactNode }): ReactNode {
  const child = Array.isArray(children) ? children[0] : children
  const props = (child as { props?: { className?: string; children?: ReactNode } } | undefined)?.props
  const language = props?.className?.match(/language-([\w-]+)/)?.[1]
  const raw = textOf(props?.children).replace(/\n$/, '')
  return (
    <div className="group/code my-2.5 overflow-hidden rounded-lg border border-line bg-inset">
      <div className="flex h-7 items-center justify-between border-b border-line pl-3 pr-1">
        <span className="font-mono text-[11px] text-subtle">{language ?? 'text'}</span>
        <CopyButton text={raw} className="opacity-0 transition-opacity group-hover/code:opacity-100" />
      </div>
      <pre className="selectable overflow-x-auto px-3 py-2.5 font-mono text-[12px] leading-[1.55]">{children}</pre>
    </div>
  )
}

const PLUGINS: NonNullable<Options['rehypePlugins']> = [[rehypeHighlight, { detect: false, ignoreMissing: true }]]
/** rehype-sanitize's default schema is GitHub's allowlist, plus links to local files. */
const SCHEMA = { ...defaultSchema, protocols: { ...defaultSchema.protocols, href: [...(defaultSchema.protocols?.href ?? []), 'file'] } }
const HTML_PLUGINS: NonNullable<Options['rehypePlugins']> = [rehypeRaw, [rehypeSanitize, SCHEMA], ...PLUGINS]
/** The default drops file: addresses, and clicks on them are handled here, not by the browser. */
const keepFileLinks = (url: string): string => (/^file:/i.test(url) ? url : defaultUrlTransform(url))

interface MarkdownProps {
  text: string
  /** Base directory for resolving relative file references. */
  root?: string | null
  /** Renders raw HTML through GitHub's allowlist. Off for chat, where tags in prose are usually code. */
  html?: boolean
  className?: string
}

export const Markdown = memo(function Markdown({ text, root, html, className }: MarkdownProps): ReactNode {
  const openFile = useStore((s) => s.openFile)

  const components = useMemo<Components>(
    () => ({
      pre: Pre as Components['pre'],
      a({ href, children }) {
        return (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault()
              if (!href) return
              if (/^(https?|mailto):/i.test(href)) void openLink(href, event)
              else {
                const file = linkedFile(href, root)
                if (file) openFile(file.path, file.line)
              }
            }}
          >
            {children}
          </a>
        )
      },
      code({ className: codeClass, children, ...rest }) {
        const inline = !codeClass && !String(children).includes('\n')
        if (inline) {
          const ref = fileReference(String(children))
          if (ref) {
            const path = ref.path.startsWith('/') || ref.path.startsWith('~') || !root ? ref.path : `${root}/${ref.path.replace(/^\.\//, '')}`
            return (
              <code
                className="cursor-pointer! decoration-subtle underline-offset-2 hover:underline"
                title="Open beside the chat"
                onClick={() => openFile(path, ref.line)}
              >
                {children}
              </code>
            )
          }
        }
        return (
          <code className={codeClass} {...rest}>
            {children}
          </code>
        )
      },
      img({ src, alt }) {
        const source = typeof src === 'string' ? src : ''
        if (!/^(https?:|data:)/i.test(source)) return <span className="text-muted">[{alt || 'image'}]</span>
        return <img src={source} alt={alt ?? ''} />
      }
    }),
    [openFile, root]
  )

  return (
    <div className={cn('md selectable', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={html ? HTML_PLUGINS : PLUGINS} urlTransform={keepFileLinks} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
