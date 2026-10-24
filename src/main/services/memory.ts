import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Every chat shares one memory file, ~/.galaxy/MEMORY.md, whatever its project. */
export function memoryPath(_projectPath?: string | null): string {
  return join(homedir(), '.galaxy', 'MEMORY.md')
}

export async function readMemory(projectPath: string | null): Promise<string> {
  try {
    return await readFile(memoryPath(projectPath), 'utf8')
  } catch {
    return ''
  }
}

export type MemoryAction =
  | { action: 'add'; content: string }
  | { action: 'replace'; old_text: string; content: string }
  | { action: 'remove'; old_text: string }
  | { action: 'rewrite'; content: string }

export async function updateMemory(
  projectPath: string | null,
  change: MemoryAction
): Promise<{ path: string; before: string; after: string }> {
  const path = memoryPath(projectPath)
  const before = await readMemory(projectPath)
  let after: string

  switch (change.action) {
    case 'add': {
      const entry = change.content.trim()
      if (!entry) throw new Error('content is empty')
      const line = /^[-*#]/.test(entry) ? entry : `- ${entry}`
      const body = before.trim() ? before.replace(/\s*$/, '\n') : '# Memory\n\n'
      after = `${body}${line}\n`
      break
    }
    case 'replace': {
      if (!before.includes(change.old_text)) throw new Error('old_text was not found in MEMORY.md')
      after = before.replace(change.old_text, change.content)
      break
    }
    case 'remove': {
      if (!before.includes(change.old_text)) throw new Error('old_text was not found in MEMORY.md')
      after = before
        .replace(change.old_text, '')
        .replace(/^[-*]\s*$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
      break
    }
    case 'rewrite': {
      after = change.content.replace(/\s*$/, '\n')
      break
    }
  }

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, after, 'utf8')
  return { path, before, after }
}
