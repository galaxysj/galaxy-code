import { BrowserWindow } from 'electron'
import TurndownService from 'turndown'
import { TitleModel } from '@shared/models'
import { store } from '../store'
import { errorMessage } from '../util'

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

export interface SearchResult {
  title: string
  url: string
  snippet?: string
}

export interface SearchResponse {
  results: SearchResult[]
  /** Present when a model summarized the results. */
  answer?: string
}

/** Loads a page in an offscreen Chromium window and evaluates a script against it. */
async function withHiddenPage<T>(url: string, script: string, signal?: AbortSignal, settleMs = 600): Promise<T> {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { partition: 'galaxy-fetch', sandbox: true, contextIsolation: true, javascript: true, images: false }
  })
  win.webContents.setUserAgent(USER_AGENT)
  win.webContents.setAudioMuted(true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const abort = (): void => {
    if (!win.isDestroyed()) win.destroy()
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    await Promise.race([
      win.loadURL(url),
      new Promise((_, fail) => setTimeout(() => fail(new Error('Timed out loading the page')), 25000))
    ])
    await new Promise((r) => setTimeout(r, settleMs))
    return (await win.webContents.executeJavaScript(script, true)) as T
  } finally {
    signal?.removeEventListener('abort', abort)
    abort()
  }
}

const SEARCH_SCRAPE = `(() => {
  const out = [];
  const decode = (href) => {
    try {
      const u = new URL(href, location.href);
      const real = u.searchParams.get('uddg');
      return real ? decodeURIComponent(real) : u.href;
    } catch { return href; }
  };
  for (const el of document.querySelectorAll('.result, .web-result')) {
    const a = el.querySelector('a.result__a');
    if (!a) continue;
    const url = decode(a.getAttribute('href') || '');
    if (!/^https?:/.test(url) || /duckduckgo\\.com\\/y\\.js/.test(url)) continue;
    const snippet = el.querySelector('.result__snippet');
    out.push({ title: a.textContent.trim(), url, snippet: snippet ? snippet.textContent.trim() : undefined });
  }
  return out;
})()`

async function searchViaPage(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  return withHiddenPage<SearchResult[]>(url, SEARCH_SCRAPE, signal)
}

/** Fallback: let OpenRouter's web plugin run the search and read back its citations. */
async function searchViaOpenRouter(query: string, signal?: AbortSignal): Promise<SearchResponse> {
  const key = store.openRouterKey
  if (!key) throw new Error('Web search is unavailable right now')
  const base = (store.settings.openRouterBaseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Galaxy Code' },
    body: JSON.stringify({
      model: TitleModel.ID,
      plugins: [{ id: 'web', max_results: 8 }],
      messages: [
        {
          role: 'user',
          content: `Search the web for: ${query}\n\nReport the key facts you find, concisely, citing sources. Do not add commentary.`
        }
      ]
    }),
    signal
  })
  if (!res.ok) throw new Error(`Web search failed (${res.status})`)
  const json = (await res.json()) as {
    choices?: { message?: { content?: string; annotations?: { type: string; url_citation?: { url: string; title?: string; content?: string } }[] } }[]
  }
  const message = json.choices?.[0]?.message
  const seen = new Set<string>()
  const results: SearchResult[] = []
  for (const annotation of message?.annotations ?? []) {
    const cite = annotation.url_citation
    if (!cite?.url || seen.has(cite.url)) continue
    seen.add(cite.url)
    results.push({ title: cite.title || cite.url, url: cite.url, snippet: cite.content?.slice(0, 300) })
  }
  return { results, answer: message?.content || undefined }
}

export async function webSearch(query: string, signal?: AbortSignal): Promise<SearchResponse> {
  let scrapeError = ''
  try {
    const results = await searchViaPage(query, signal)
    if (results.length > 0) return { results: results.slice(0, 10) }
  } catch (err) {
    if (signal?.aborted) throw err
    scrapeError = errorMessage(err)
  }
  try {
    return await searchViaOpenRouter(query, signal)
  } catch (err) {
    if (signal?.aborted) throw err
    throw new Error(scrapeError ? `Web search failed: ${scrapeError}` : errorMessage(err))
  }
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
turndown.remove(['script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'template', 'form', 'nav', 'footer', 'aside'] as never)

function htmlToMarkdown(html: string): { title: string; markdown: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() ?? ''
  const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html.match(/<article[\s\S]*?<\/article>/i)?.[0]
  const body = main && main.length > 800 ? main : (html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html)
  const markdown = turndown
    .turndown(body)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, markdown }
}

const PAGE_TEXT = `(() => ({
  title: document.title,
  html: (document.querySelector('main, article, [role="main"]') || document.body).outerHTML
}))()`

export interface FetchedPage {
  url: string
  title: string
  contentType: string
  text: string
}

export async function webFetch(rawUrl: string, signal?: AbortSignal): Promise<FetchedPage> {
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`)
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`)
  }

  let direct: FetchedPage | null = null
  let directError = ''
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.8' },
      redirect: 'follow',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
    })
    const contentType = res.headers.get('content-type') ?? ''
    if (!res.ok) {
      directError = `HTTP ${res.status}`
    } else if (/^(image|audio|video)\/|application\/(pdf|zip|octet-stream)/.test(contentType)) {
      throw new Error(`Cannot read ${contentType} content. Download it with Bash instead.`)
    } else {
      const raw = await res.text()
      if (/html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(raw)) {
        const { title, markdown } = htmlToMarkdown(raw)
        direct = { url: res.url, title, contentType, text: markdown }
      } else {
        direct = { url: res.url, title: '', contentType, text: raw }
      }
    }
  } catch (err) {
    if (signal?.aborted) throw err
    if (err instanceof Error && err.message.startsWith('Cannot read')) throw err
    directError = errorMessage(err)
  }

  // Pages that render client-side or block plain HTTP clients come back thin or not at all.
  if (direct && direct.text.length >= 400) return direct
  try {
    const page = await withHiddenPage<{ title: string; html: string }>(url.toString(), PAGE_TEXT, signal, 1500)
    const { markdown } = htmlToMarkdown(page.html)
    if (markdown.length > (direct?.text.length ?? 0)) {
      return { url: url.toString(), title: page.title, contentType: 'text/html', text: markdown }
    }
  } catch (err) {
    if (signal?.aborted) throw err
    if (!direct) throw new Error(`Could not fetch ${url.toString()}: ${directError || errorMessage(err)}`)
  }
  if (direct) return direct
  throw new Error(`Could not fetch ${url.toString()}: ${directError}`)
}
