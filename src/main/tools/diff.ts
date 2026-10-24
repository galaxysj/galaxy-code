import { structuredPatch } from 'diff'
import type { FileDiff } from '@shared/types'

/** Builds a display diff between two versions of a file. */
export function makeDiff(path: string, before: string | null, after: string | null): FileDiff {
  const patch = structuredPatch(path, path, before ?? '', after ?? '', undefined, undefined, { context: 3 })
  let added = 0
  let removed = 0
  const lines: string[] = []
  for (const hunk of patch.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
      if (!line.startsWith('\\')) lines.push(line)
    }
  }
  return {
    path,
    added,
    removed,
    patch: lines.join('\n'),
    created: before === null,
    deleted: after === null
  }
}

/** Counts a unified diff produced elsewhere and strips its file headers. */
export function diffFromUnified(path: string, unified: string, flags: { created?: boolean; deleted?: boolean } = {}): FileDiff {
  let added = 0
  let removed = 0
  const lines: string[] = []
  let inHunk = false
  for (const line of unified.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true
      lines.push(line)
      continue
    }
    if (!inHunk) {
      if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) continue
      // Headerless bodies, as some CLIs send for new files.
      inHunk = true
    }
    if (line.startsWith('\\')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
    lines.push(line)
  }
  return { path, added, removed, patch: lines.join('\n').replace(/\n+$/, ''), ...flags }
}
