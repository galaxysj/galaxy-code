import { cp, lstat, mkdir, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { shell } from 'electron'
import fg from 'fast-glob'
import type { ProjectFileEntry } from '@shared/types'
import { store } from '../store'

async function projectRoot(projectId: string, chatId?: string): Promise<string> {
  const project = store.project(projectId)
  if (!project) throw new Error('Choose a project to browse files.')
  const chat = chatId ? store.chats.get(chatId) : undefined
  return realpath(chat?.projectId === projectId && chat.worktree ? chat.worktree.path : project.path)
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

export async function listProjectFiles(projectId: string, relativePath: string, chatId?: string): Promise<ProjectFileEntry[]> {
  const root = await projectRoot(projectId, chatId)
  const path = resolve(root, relativePath || '.')
  if (!within(root, path) || !within(root, await realpath(path))) throw new Error('This folder is outside the current project.')
  const entries = await readdir(path, { withFileTypes: true })
  return entries.filter((entry) => !entry.isSymbolicLink()).map((entry) => ({ name: entry.name, path: join(path, entry.name), relativePath: relative(root, join(path, entry.name)), directory: entry.isDirectory() }))
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, undefined, { numeric: true }))
}

export async function searchProjectFiles(projectId: string, query: string, chatId?: string): Promise<ProjectFileEntry[]> {
  const root = await projectRoot(projectId, chatId)
  const paths = await fg('**/*', { cwd: root, dot: true, onlyFiles: true, followSymbolicLinks: false, ignore: ['**/.git/**', '**/node_modules/**'], suppressErrors: true })
  const needle = query.toLowerCase()
  return paths.filter((path) => path.toLowerCase().includes(needle)).sort().slice(0, 300).map((path) => ({ name: basename(path), path: join(root, path), relativePath: path, directory: false }))
}

/** Resolves a path inside the project, refusing anything that leaves it, including through a symlinked folder. */
async function insideProject(root: string, relativePath: string): Promise<string> {
  const path = resolve(root, relativePath || '.')
  if (!within(root, path)) throw new Error('This path is outside the current project.')
  const parent = await realpath(dirname(path)).catch(() => null)
  if (parent && !within(root, parent)) throw new Error('This path is outside the current project.')
  return path
}

function entryFor(root: string, path: string, directory: boolean): ProjectFileEntry {
  return { name: basename(path), path, relativePath: relative(root, path), directory }
}

function checkName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..') throw new Error('Enter a name.')
  if (/[\\:]/.test(trimmed) || trimmed.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`"${trimmed}" is not a valid name.`)
  return trimmed
}

/** Creates an empty file or a folder in `parent`. The name may hold slashes to create folders on the way. */
export async function createProjectEntry(projectId: string, parent: string, name: string, directory: boolean, chatId?: string): Promise<ProjectFileEntry> {
  const root = await projectRoot(projectId, chatId)
  const path = await insideProject(root, join(parent, checkName(name)))
  if (await lstat(path).then(() => true, () => false)) throw new Error(`${basename(path)} already exists.`)
  if (directory) await mkdir(path, { recursive: true })
  else {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '', { flag: 'wx' })
  }
  return entryFor(root, path, directory)
}

/** Renames a file or folder in place. */
export async function renameProjectEntry(projectId: string, relativePath: string, name: string, chatId?: string): Promise<ProjectFileEntry> {
  const root = await projectRoot(projectId, chatId)
  const from = await insideProject(root, relativePath)
  if (from === root) throw new Error('The project folder cannot be renamed here.')
  const to = await insideProject(root, join(dirname(relativePath), checkName(name)))
  if (to === from) return entryFor(root, from, (await lstat(from)).isDirectory())
  // A change of case only is the same file on case-insensitive disks.
  if (to.toLowerCase() !== from.toLowerCase() && await lstat(to).then(() => true, () => false)) throw new Error(`${basename(to)} already exists.`)
  const directory = (await lstat(from)).isDirectory()
  await mkdir(dirname(to), { recursive: true })
  await rename(from, to)
  return entryFor(root, to, directory)
}

/** A free name in `folder`, adding " copy", " copy 2"… before the extension as Finder does. */
async function freeName(folder: string, name: string, directory: boolean): Promise<string> {
  const ext = directory ? '' : extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  for (let index = 0; ; index++) {
    const candidate = index === 0 ? name : `${stem} copy${index > 1 ? ` ${index}` : ''}${ext}`
    if (!(await lstat(join(folder, candidate)).then(() => true, () => false))) return candidate
  }
}

/** Copies files and folders into `parent`, renaming when a name is taken. */
export async function copyProjectEntries(projectId: string, relativePaths: string[], parent: string, chatId?: string): Promise<ProjectFileEntry[]> {
  const root = await projectRoot(projectId, chatId)
  const folder = await insideProject(root, join(parent || '.', 'x')).then(dirname)
  const copied: ProjectFileEntry[] = []
  for (const relativePath of relativePaths) {
    const from = await insideProject(root, relativePath)
    if (from === root) throw new Error('The project folder cannot be copied here.')
    const directory = (await lstat(from)).isDirectory()
    if (directory && (folder === from || folder.startsWith(`${from}${sep}`))) throw new Error(`${basename(from)} cannot be copied into itself.`)
    const to = join(folder, await freeName(folder, basename(from), directory))
    await cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
    copied.push(entryFor(root, to, directory))
  }
  return copied
}

/** Moves a file or folder to the system Trash, so it can be put back. */
export async function trashProjectEntry(projectId: string, relativePath: string, chatId?: string): Promise<void> {
  const root = await projectRoot(projectId, chatId)
  const path = await insideProject(root, relativePath)
  if (path === root) throw new Error('The project folder cannot be moved to the Trash here.')
  await shell.trashItem(path)
}
