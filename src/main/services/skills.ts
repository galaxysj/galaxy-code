import { mkdir, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { app } from 'electron'
import type { SkillInfo } from '@shared/types'

/** Skills that ship with the app. Packaged, they sit outside the archive so their scripts can run. */
export function builtinSkillsDir(): string {
  return join(app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'), 'resources', 'skills')
}

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

const MAX_ICON_BYTES = 1_000_000
const ICON_TYPES: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

/** The sections of agents/openai.yaml the app reads. Lists such as dependencies are skipped. */
function parseOpenAiYaml(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  let section = ''
  for (const line of text.split(/\r?\n/)) {
    const top = line.match(/^([a-z_]+):\s*$/)
    if (top) {
      section = top[1]
      continue
    }
    const field = line.match(/^ {2}([a-z_]+):\s*(.+?)\s*$/)
    if (field && section) (out[section] ??= {})[field[1]] = field[2].replace(/^["']|["']$/g, '')
  }
  return out
}

/** A skill's icon, only from inside its own folder. */
async function readIcon(folder: string, relative: string | undefined): Promise<string | undefined> {
  if (!relative) return undefined
  const path = resolve(folder, relative)
  const type = ICON_TYPES[extname(path).toLowerCase()]
  if (!type || !path.startsWith(resolve(folder) + sep)) return undefined
  const data = await readFile(path).catch(() => null)
  return data && data.length <= MAX_ICON_BYTES ? `data:${type};base64,${data.toString('base64')}` : undefined
}

async function readInterface(folder: string): Promise<Partial<SkillInfo>> {
  const text = await readFile(join(folder, 'agents', 'openai.yaml'), 'utf8').catch(() => '')
  const { interface: ui = {}, policy = {} } = parseOpenAiYaml(text)
  return {
    displayName: ui.display_name,
    shortDescription: ui.short_description,
    icon: await readIcon(folder, ui.icon_small),
    iconLarge: await readIcon(folder, ui.icon_large),
    brandColor: /^#[0-9a-f]{3,8}$/i.test(ui.brand_color ?? '') ? ui.brand_color : undefined,
    implicit: policy.allow_implicit_invocation !== 'false'
  }
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
      skills.push({ name: meta.name || entry, description: meta.description || '', path, scope, ...(await readInterface(join(dir, entry))) })
    } catch {
      // not a skill folder
    }
  }
  return skills
}

/** Project skills shadow user skills with the same name, and both shadow built-in ones. */
export async function listSkills(projectPath: string | null): Promise<SkillInfo[]> {
  const [builtin, user, project] = await Promise.all([
    scan(builtinSkillsDir(), 'builtin'),
    scan(userSkillsDir(), 'user'),
    projectPath ? scan(projectSkillsDir(projectPath), 'project') : Promise.resolve([])
  ])
  const names = new Set(project.map((s) => s.name))
  const kept = [...project, ...user.filter((s) => !names.has(s.name))]
  const taken = new Set(kept.map((s) => s.name))
  return [...kept, ...builtin.filter((s) => !taken.has(s.name))]
}

/**
 * If `path` is a SKILL.md inside a skills folder, returns the skill name so the
 * UI can show "Read <name> skill". Falls back to the folder name without I/O.
 */
export function skillNameForPath(path: string, known: SkillInfo[]): string | null {
  const abs = resolve(path)
  const hit = known.find((s) => resolve(s.path) === abs)
  if (hit) return hit.displayName ?? hit.name
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
