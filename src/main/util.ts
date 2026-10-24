import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'

export function newId(prefix = ''): string {
  return prefix + randomBytes(9).toString('base64url')
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(data), 'utf8')
  await rename(tmp, file)
}

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

export function resolvePath(cwd: string, p: string): string {
  const expanded = expandHome(p.trim())
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)
}

export function tildify(p: string): string {
  const home = homedir()
  return p === home ? '~' : p.startsWith(home + '/') ? '~' + p.slice(home.length) : p
}

/** Path shown in tool titles: relative to cwd when inside it, home-shortened otherwise. */
export function displayPath(cwd: string, p: string): string {
  const abs = resolvePath(cwd, p)
  if (abs === cwd) return '.'
  if (abs.startsWith(cwd + '/')) return abs.slice(cwd.length + 1)
  return tildify(abs)
}

export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  const tail = max - head
  const dropped = text.length - max
  return `${text.slice(0, head)}\n\n[... ${dropped.toLocaleString()} characters truncated ...]\n\n${text.slice(-tail)}`
}

export function truncateEnd(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n[... truncated, ${(text.length - max).toLocaleString()} more characters]`
}

export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || /aborted|abort/i.test(err.message))
}

export async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
}

export function mimeOf(p: string): string {
  return MIME[extname(p).toLowerCase()] ?? 'text/plain'
}

export function isImagePath(p: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(p)
}

/** Heuristic binary check on the first bytes of a file. */
export function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 4096)
  let suspicious = 0
  for (let i = 0; i < len; i++) {
    const b = buf[i]
    if (b === 0) return true
    if (b < 7 || (b > 14 && b < 32 && b !== 27)) suspicious++
  }
  return len > 0 && suspicious / len > 0.1
}

/**
 * GUI apps on macOS start with a bare PATH. Ask the login shell for the real
 * one so `git`, `claude`, `codex` and friends resolve the way they do in a terminal.
 */
export async function hydrateShellPath(): Promise<void> {
  if (process.platform === 'win32') return
  const shell = process.env.SHELL || '/bin/zsh'
  const marker = '__GALAXY_PATH__'
  const found = await new Promise<string | null>((done) => {
    execFile(
      shell,
      ['-ilc', `printf '%s%s%s' '${marker}' "$PATH" '${marker}'`],
      { timeout: 5000, env: process.env },
      (_err, stdout) => {
        const match = stdout?.match(new RegExp(`${marker}(.*?)${marker}`, 's'))
        done(match ? match[1] : null)
      }
    )
  })
  const extra = [
    join(homedir(), '.local/bin'),
    join(homedir(), '.bun/bin'),
    join(homedir(), '.cargo/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
  const parts = [...(found ?? '').split(delimiter), ...(process.env.PATH ?? '').split(delimiter), ...extra]
  process.env.PATH = [...new Set(parts.filter(Boolean))].join(delimiter)
}

export async function which(binary: string): Promise<string | null> {
  if (binary.includes('/')) return (await exists(expandHome(binary))) ? expandHome(binary) : null
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, binary)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // keep looking
    }
  }
  return null
}

export function run(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(
      command,
      args,
      { cwd: options.cwd, timeout: options.timeout ?? 15000, env: options.env ?? process.env, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0
        done({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }
    )
  })
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done, fail) => {
    const timer = setTimeout(done, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        fail(new DOMException('Aborted', 'AbortError'))
      },
      { once: true }
    )
  })
}

export function slugify(text: string, max = 32): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/g, '') || 'chat'
  )
}
