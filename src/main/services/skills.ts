import { mkdir, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { SkillInfo } from '@shared/types'

export function userSkillsDir(): string {
  return join(homedir(), '.galaxy', 'skills')
}

export function projectSkillsDir(projectPath: string): string {
  return join(projectPath, '.galaxy', 'skills')
}

/** Reads `name` and `description` out of a SKILL.md front matter block. */
function parseFrontMatter(text: string): { name?: string; description?: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const out: Record<string, string> = {}
  const lines = match[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_-]+):\s*(.*)$/)
    if (!kv) continue
    let value = kv[2].trim()
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const folded: string[] = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) folded.push(lines[++i].trim())
      value = folded.join(' ')
    }
    out[kv[1].toLowerCase()] = value.replace(/^["']|["']$/g, '')
  }
  return { name: out.name, description: out.description }
}

async function scan(dir: string, scope: SkillInfo['scope']): Promise<SkillInfo[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const skills: SkillInfo[] = []
  for (const entry of entries.sort()) {
    const path = join(dir, entry, 'SKILL.md')
    try {
      const text = await readFile(path, 'utf8')
      const meta = parseFrontMatter(text)
      skills.push({ name: meta.name || entry, description: meta.description || '', path, scope })
    } catch {
      // not a skill folder
    }
  }
  return skills
}

/** Project skills shadow user skills with the same name. */
export async function listSkills(projectPath: string | null): Promise<SkillInfo[]> {
  const [user, project] = await Promise.all([
    scan(userSkillsDir(), 'user'),
    projectPath ? scan(projectSkillsDir(projectPath), 'project') : Promise.resolve([])
  ])
  const names = new Set(project.map((s) => s.name))
  return [...project, ...user.filter((s) => !names.has(s.name))]
}

/**
 * If `path` is a SKILL.md inside a skills folder, returns the skill name so the
 * UI can show "Read <name> skill". Falls back to the folder name without I/O.
 */
export function skillNameForPath(path: string, known: SkillInfo[]): string | null {
  const abs = resolve(path)
  const hit = known.find((s) => resolve(s.path) === abs)
  if (hit) return hit.name
  if (basename(abs) !== 'SKILL.md') return null
  const folder = dirname(abs)
  const parent = dirname(folder)
  if (basename(parent) === 'skills' && basename(dirname(parent)) === '.galaxy') return basename(folder)
  return null
}

export async function ensureSkillsDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  return dir
}
