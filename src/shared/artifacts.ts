import type { TaskEntry } from './types'

/** Artifacts live outside the project, in ~/.galaxy/<chat id>/artifacts. */
const ARTIFACT_PATH = /[/\\]\.galaxy[/\\][^/\\]+[/\\]artifacts[/\\]([^/\\]+)$/

/** The artifact's file name when the path is inside a chat's artifacts folder, else null. */
export function artifactName(path: string): string | null {
  return ARTIFACT_PATH.exec(path)?.[1] ?? null
}

export const PLAN_ARTIFACT = 'plan.md'
export const TASKS_ARTIFACT = 'task.md'

/** What the app calls an artifact: Plan, Tasks, or the file name for any other. Null outside the artifacts folder. */
export function artifactTitle(path: string): string | null {
  const name = artifactName(path)
  if (!name) return null
  const lower = name.toLowerCase()
  return lower === PLAN_ARTIFACT ? 'Plan' : lower === TASKS_ARTIFACT ? 'Task' : isScreenshotName(lower) ? screenshotTitle(name) : name
}

/** When a browser screenshot was taken, read from its file name (browser-2026-11-06T12-39-21-060Z-...), or null. */
export function screenshotTime(name: string): Date | null {
  const match = /^browser-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/i.exec(name)
  const time = match ? new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`) : null
  return time && !Number.isNaN(time.getTime()) ? time : null
}

/** Screenshot (Nov 6, 12:39 PM): the date and time in the US style, in the viewer's time zone. */
export function screenshotTitle(name: string): string {
  const time = screenshotTime(name)
  return time ? `Screenshot (${time.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })})` : 'Screenshot'
}

/** The browser's screenshots are saved as browser-<time>-<n>-<action>.png in the artifacts folder. */
export const isScreenshotName = (name: string): boolean => /^browser-.*\.png$/i.test(name)
export const isScreenshotArtifact = (path: string): boolean => isScreenshotName(artifactName(path) ?? '')

export const isTasksArtifact = (path: string): boolean => artifactName(path)?.toLowerCase() === TASKS_ARTIFACT

/**
 * Reads the task file: `* [ ]` pending, `* [/]` in progress, `* [x]` done; a bullet with no box is pending.
 * Nested bullets keep their depth.
 */
export function parseTaskMarkdown(text: string): TaskEntry[] {
  const tasks: TaskEntry[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\s*)[*+-]\s+(?:\[([ xX/~-])\]\s*)?(.+?)\s*$/.exec(line)
    if (!match || !match[3]) continue
    const mark = match[2]
    const status = mark === 'x' || mark === 'X' ? 'completed' : mark === '/' || mark === '~' ? 'in_progress' : 'pending'
    const indent = match[1].replace(/\t/g, '  ').length
    tasks.push({ content: match[3], status, ...(indent > 0 ? { depth: Math.min(4, Math.ceil(indent / 2)) } : {}) })
  }
  return tasks
}

/** Plan and Task have their own places in the app; every other artifact is a Markdown document the agent chose to write. */
export const isDocumentArtifact = (path: string): boolean => {
  const name = artifactName(path)?.toLowerCase()
  return !!name && name.endsWith('.md') && name !== PLAN_ARTIFACT && name !== TASKS_ARTIFACT
}

export interface FrontMatter {
  /** The block as written, closing line and newline included, or '' when there is none. */
  raw: string
  meta: Record<string, string>
  /** The document after the block. */
  body: string
}

/** Reads the `---` block at the top of a document: `key: value` lines. */
export function parseFrontMatter(text: string): FrontMatter {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return { raw: '', meta: {}, body: text }
  const meta: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/.exec(line)
    if (pair) meta[pair[1].toLowerCase()] = pair[2].replace(/^(["'])(.*)\1$/, '$2')
  }
  return { raw: match[0], meta, body: text.slice(match[0].length) }
}

/** Whether the user may edit the document. Only `user-editable: false` locks it. */
export const userEditable = (text: string): boolean => parseFrontMatter(text).meta['user-editable']?.toLowerCase() !== 'false'

/**
 * A save by hand may change the name and the body but not `user-editable`: that line is put back as it was in the
 * file on disk, and a front matter block the edit deleted comes back.
 */
export function keepLockedMeta(previous: string, next: string): string {
  const before = parseFrontMatter(previous)
  const lockedLine = /^user-editable\s*:.*$/im.exec(before.raw)?.[0]
  if (!before.raw) return next
  const after = parseFrontMatter(next)
  if (!after.raw) return before.raw + next
  const lines = after.raw.replace(/\r?\n$/, '').split(/\r?\n/)
  const kept = lines.filter((line, index) => index === 0 || index === lines.length - 1 || !/^user-editable\s*:/i.test(line))
  if (lockedLine) kept.splice(kept.length - 1, 0, lockedLine)
  return kept.join('\n') + '\n' + after.body
}

/** Why a document artifact's front matter is not acceptable, or null. A document needs a name and a user-editable of true or false. */
export function frontMatterProblem(text: string): string | null {
  const { raw, meta } = parseFrontMatter(text)
  if (!raw) return 'A document artifact must start with a front matter block:\n---\nname: Title shown to the user\nuser-editable: false\n---'
  if (!meta.name?.trim()) return 'The front matter needs a `name:` line with the title the user sees.'
  if (!['true', 'false'].includes(meta['user-editable']?.toLowerCase() ?? '')) return 'The front matter needs `user-editable: true` or `user-editable: false`.'
  return null
}
