import { readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
