import type { ToolItem } from '@shared/types'

// Explicit forms also cover irregular verbs; never change filenames or URL text.
const VERBS = [
  ['Open', 'Opened', 'Opening'],
  ['Close', 'Closed', 'Closing'],
  ['Read', 'Read', 'Reading'],
  ['List', 'Listed', 'Listing'],
  ['Search', 'Searched', 'Searching'],
  ['Grep', 'Grepped', 'Grepping'],
  ['Glob', 'Globbed', 'Globbing'],
  ['Fetch', 'Fetched', 'Fetching'],
  ['View', 'Viewed', 'Viewing'],
  ['Click', 'Clicked', 'Clicking'],
  ['Type', 'Typed', 'Typing'],
  ['Press', 'Pressed', 'Pressing'],
  ['Scroll', 'Scrolled', 'Scrolling'],
  ['Take', 'Took', 'Taking'],
  ['Run', 'Ran', 'Running'],
  ['Go', 'Went', 'Going'],
  ['Reload', 'Reloaded', 'Reloading'],
  ['Wait', 'Waited', 'Waiting'],
  ['Edit', 'Edited', 'Editing'],
  ['Create', 'Created', 'Creating'],
  ['Write', 'Wrote', 'Writing'],
  ['Overwrite', 'Overwrote', 'Overwriting'],
  ['Rewrite', 'Rewrote', 'Rewriting'],
  ['Save', 'Saved', 'Saving'],
  ['Remove', 'Removed', 'Removing'],
  ['Delete', 'Deleted', 'Deleting'],
  ['Move', 'Moved', 'Moving'],
  ['Plan', 'Planned', 'Planning'],
  ['Update', 'Updated', 'Updating'],
  ['Add', 'Added', 'Adding'],
  ['Present', 'Presented', 'Presenting'],
  ['Generate', 'Generated', 'Generating'],
  ['Check', 'Checked', 'Checking'],
  ['Stop', 'Stopped', 'Stopping'],
  ['Interrupt', 'Interrupted', 'Interrupting'],
  ['Message', 'Messaged', 'Messaging'],
  ['Install', 'Installed', 'Installing'],
  ['Build', 'Built', 'Building'],
  ['Test', 'Tested', 'Testing'],
  ['Start', 'Started', 'Starting'],
  ['Load', 'Loaded', 'Loading'],
  ['Navigate', 'Navigated', 'Navigating'],
  ['Inspect', 'Inspected', 'Inspecting'],
  ['Fix', 'Fixed', 'Fixing'],
  ['Review', 'Reviewed', 'Reviewing'],
  ['Analyze', 'Analyzed', 'Analyzing'],
  ['Execute', 'Executed', 'Executing'],
  ['Propose', 'Proposed', 'Proposing']
] as const

const FORMS = new Map<string, readonly [string, string, string]>()
for (const forms of VERBS) for (const form of forms) FORMS.set(form, forms)

export function isToolInProgress(item: ToolItem): boolean {
  return item.status === 'pending' || item.status === 'awaiting' || item.status === 'running'
}

/** Display tense follows the current status, including the permission wait. */
/** The path a read tool opened, if any. */
export function readPath(item: ToolItem): string {
  if (item.tool !== 'read') return ''
  const input = item.input as { path?: unknown; file_path?: unknown } | null
  return String(input?.path ?? input?.file_path ?? '')
}

/** Reads of a background command's log file. */
export function isTerminalRead(item: ToolItem): boolean {
  return /[/\\]galaxy-code[/\\]bg-[^/\\]+\.log$/.test(readPath(item))
}

export function toolActivityTitle(item: ToolItem): string {
  if (item.tool === 'bash') {
    if (!/^(?:Run|Ran|Running)\s+/i.test(item.title)) return item.title
    const title = item.title.replace(/^(?:Run|Ran|Running)\s+/i, '').trim()
    return title ? title.charAt(0).toUpperCase() + title.slice(1) : 'Terminal command'
  }
  // Background command logs read as the terminal they came from.
  if (isTerminalRead(item)) return isToolInProgress(item) ? 'Reading terminal' : 'Read terminal'
  // These titles are names, questions or user-provided artifact labels.
  if (item.tool === 'agent' || item.tool === 'ask' || item.tool === 'mcp') return item.title
  if (item.tool === 'present' && (item.input as { title?: unknown } | null)?.title) return item.title
  const first = item.title.match(/^([A-Za-z]+)(?=\s|$)/)?.[1]
  const forms = first ? FORMS.get(first) : undefined
  if (!forms) return item.title
  const verb = forms[isToolInProgress(item) ? 2 : item.status === 'done' ? 1 : 0]
  const title = verb + item.title.slice(first!.length)
  return item.tool === 'browser'
    ? title.replace(/^(Open(?:ing|ed)?) https?:\/\/(?:www\.)?/, '$1 ')
    : title
}
