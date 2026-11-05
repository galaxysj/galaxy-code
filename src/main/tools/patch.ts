import { applyDiff, parsePatch, type ParsedPatch } from '@galaxysj/v4a'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { FileDiff } from '@shared/types'
import { resolvePath } from '../util'
import { makeDiff } from './diff'
import { ToolInputError } from './types'

/** Patch paths may point anywhere; files outside the working directory are gated by approval instead. */
function patchPath(cwd: string, path: string): string {
  if (!path.trim()) throw new ToolInputError('Patch path is empty')
  return resolvePath(cwd, path)
}

export function parseEditPatch(patch: string, cwd: string): ParsedPatch {
  const parsed = parsePatch(patch)
  for (const operation of parsed.operations) {
    patchPath(cwd, operation.path)
    if (operation.type === 'update' && operation.moveTo) patchPath(cwd, operation.moveTo)
  }
  return parsed
}

export function patchFiles(parsed: ParsedPatch, cwd: string): string[] {
  return [...new Set(parsed.operations.flatMap((operation) => [
    patchPath(cwd, operation.path),
    ...(operation.type === 'update' && operation.moveTo ? [patchPath(cwd, operation.moveTo)] : [])
  ]))]
}

/** Use the package's diff engine to compute every file's final content without writing. */
async function planEditPatch(patch: string, cwd: string): Promise<{ before: Map<string, string | null>; contents: Map<string, string | null> }> {
  const parsed = parseEditPatch(patch, cwd)
  const before = new Map<string, string | null>()
  const contents = new Map<string, string | null>()
  const load = async (path: string): Promise<string | null> => {
    if (!contents.has(path)) {
      const content = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      before.set(path, content)
      contents.set(path, content)
    }
    return contents.get(path)!
  }
  for (const operation of parsed.operations) {
    const path = patchPath(cwd, operation.path)
    const original = await load(path)
    if (operation.type === 'add') {
      if (original !== null) throw new ToolInputError(`File already exists: ${operation.path}. Use Update File to edit it.`)
      contents.set(path, operation.lines.join('\n'))
    } else if (operation.type === 'delete') {
      if (original === null) throw new ToolInputError(`File not found: ${operation.path}`)
      contents.set(path, null)
    } else {
      if (original === null) throw new ToolInputError(`File not found: ${operation.path}`)
      const updated = applyDiff(original, operation.diff)
      const destination = operation.moveTo ? patchPath(cwd, operation.moveTo) : path
      await load(destination)
      contents.set(destination, updated)
      if (destination !== path) contents.set(path, null)
    }
  }
  return { before, contents }
}

export async function previewEditPatch(patch: string, cwd: string): Promise<FileDiff[]> {
  const { before, contents } = await planEditPatch(patch, cwd)
  return [...before].flatMap(([path, original]) => {
    const updated = contents.get(path)!
    return original === updated ? [] : [makeDiff(path, original, updated)]
  })
}

export async function applyEditPatch(patch: string, cwd: string, signal: AbortSignal): Promise<FileDiff[]> {
  // Preflight all hunks first so an invalid later operation cannot leave earlier edits behind.
  const { before, contents } = await planEditPatch(patch, cwd)
  signal.throwIfAborted()
  // Written here rather than with the package's applyPatch, which refuses paths outside cwd.
  const changed = [...before].filter(([path, original]) => contents.get(path) !== original)
  // Write before deleting, so a failed move never loses its source.
  for (const [path] of changed) {
    const updated = contents.get(path)
    if (updated == null) continue
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, updated, 'utf8')
  }
  for (const [path] of changed) {
    if (contents.get(path) === null) await unlink(path)
  }
  return changed.map(([path, original]) => makeDiff(path, original, contents.get(path)!))
}
