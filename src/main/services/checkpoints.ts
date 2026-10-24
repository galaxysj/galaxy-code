import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import fg from 'fast-glob'
import { exists, newId } from '../util'

/**
 * File checkpoints for reverting a chat. Each snapshot is a manifest of every file under
 * the chat's folder (path -> content hash), with contents kept once per hash. It needs no
 * git: plain folders work, and nothing is written inside the project.
 */

/** Folders that are rebuilt rather than edited, and too large to copy each turn. */
const SKIPPED = ['**/.git/**', '**/node_modules/**', '**/.next/**', '**/dist/**', '**/out/**', '**/build/**', '**/.venv/**', '**/venv/**', '**/__pycache__/**', '**/target/**', '**/.DS_Store']
const MAX_FILE = 5 * 1024 * 1024
const MAX_FILES = 40_000

interface Entry {
  hash: string
  size: number
  mtime: number
}

type Manifest = Record<string, Entry>

function dir(chatId: string): string {
  return join(app.getPath('userData'), 'checkpoints', chatId)
}

async function readManifest(chatId: string, id: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(dir(chatId), 'snapshots', `${id}.json`), 'utf8')) as Manifest
}

/** The previous snapshot of a chat, so unchanged files are not read again. */
const lastManifest = new Map<string, Manifest>()

/** Records the folder's current state and returns the snapshot id, or null when it is too large to track. */
export async function snapshot(chatId: string, root: string): Promise<string | null> {
  const files = await fg('**/*', { cwd: root, dot: true, onlyFiles: true, followSymbolicLinks: false, ignore: SKIPPED, suppressErrors: true, stats: true })
  if (files.length > MAX_FILES) return null
  const base = dir(chatId)
  await mkdir(join(base, 'blobs'), { recursive: true })
  await mkdir(join(base, 'snapshots'), { recursive: true })
  const previous = lastManifest.get(chatId) ?? {}
  const manifest: Manifest = {}
  for (const file of files) {
    const size = file.stats?.size ?? 0
    const mtime = file.stats?.mtimeMs ?? 0
    if (size > MAX_FILE) continue
    const known = previous[file.path]
    if (known && known.size === size && known.mtime === mtime) {
      manifest[file.path] = known
      continue
    }
    const data = await readFile(join(root, file.path)).catch(() => null)
    if (!data) continue
    const hash = createHash('sha1').update(data).digest('hex')
    const blob = join(base, 'blobs', hash)
    if (!(await exists(blob))) await writeFile(blob, data)
    manifest[file.path] = { hash, size, mtime }
  }
  const id = newId('cp_')
  await writeFile(join(base, 'snapshots', `${id}.json`), JSON.stringify(manifest))
  lastManifest.set(chatId, manifest)
  return id
}

/** Paths whose content differs between two snapshots. */
export async function changedFiles(chatId: string, from: string, to: string): Promise<string[]> {
  const [a, b] = await Promise.all([readManifest(chatId, from), readManifest(chatId, to)])
  const paths = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...paths].filter((path) => a[path]?.hash !== b[path]?.hash).sort()
}

/** Puts the given paths back to how they were in a snapshot, deleting ones it did not have. */
export async function restoreFiles(chatId: string, root: string, id: string, paths: string[]): Promise<void> {
  const manifest = await readManifest(chatId, id)
  for (const path of paths) {
    const target = join(root, path)
    const entry = manifest[path]
    if (!entry) {
      await rm(target, { force: true })
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, await readFile(join(dir(chatId), 'blobs', entry.hash)))
  }
  lastManifest.delete(chatId)
}

export async function removeCheckpoints(chatId: string): Promise<void> {
  lastManifest.delete(chatId)
  await rm(dir(chatId), { recursive: true, force: true })
}
