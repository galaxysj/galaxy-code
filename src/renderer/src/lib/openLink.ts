import { useStore } from '../store'

/**
 * The file a Markdown link points at, or null for web addresses, anchors and other schemes. Someone
 * wrote this as a link on purpose, so any path counts, whatever its name looks like.
 */
export function linkedFile(href: string, root?: string | null): { path: string; line?: number } | null {
  if (href.startsWith('#') || (/^[a-z][a-z\d+.-]+:/i.test(href) && !/^file:/i.test(href))) return null
  let value = href.replace(/^file:(\/\/(localhost)?)?/i, '').replace(/\?[^/]*$/, '')
  try {
    value = decodeURIComponent(value)
  } catch { /* A stray % in the name: keep it as written. */ }
  const line = value.match(/(?::(\d+)(?:-\d+)?|#L(\d+)(?:-L?\d+)?)$/)
  const path = (line ? value.slice(0, line.index) : value).replace(/#.*$/, '')
  if (!path) return null
  return { path: /^[/~]/.test(path) || !root ? path : `${root}/${path.replace(/^\.\//, '')}`, line: line ? Number(line[1] ?? line[2]) : undefined }
}

/** Opens a web link where Settings says to, or in the other browser when Option is held. */
export async function openLink(url: string, event?: { altKey?: boolean }): Promise<void> {
  const external = (useStore.getState().settings.browserOpenLinks === 'default') !== !!event?.altKey
  if (external || !/^https?:/i.test(url)) {
    await window.galaxy.files.openExternal(url)
    return
  }
  try {
    const id = await window.galaxy.browser.create()
    useStore.getState().addPanelTab({ id, type: 'browser', title: 'New tab' })
    await window.galaxy.browser.navigate(url, id)
  } catch (error) {
    useStore.getState().notify(error instanceof Error ? error.message : String(error), 'error')
  }
}
