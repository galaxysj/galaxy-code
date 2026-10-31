import { spawn } from 'node:child_process'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parsePatch } from 'diff'
import type { FileDiff } from '@shared/types'
import type { ReviewCommit, ReviewOptions } from '@shared/api'
import { isReviewBinaryPath, isReviewTextDiff } from '@shared/review'
import { diffFromUnified, makeDiff } from '../tools/diff'
import { gitInfo } from './git'
import { looksBinary } from '../util'

function git(cwd: string, args: string[], timeoutMs = 30000): Promise<string> {
  // Stream stdout instead of using execFile's fixed maxBuffer.
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-pager', '-c', 'core.quotePath=false', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: string[] = []
    let error = ''
    let timedOut = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => chunks.push(chunk))
    child.stderr.on('data', (chunk: string) => { error = (error + chunk).slice(-65536) })
    const timeout = timeoutMs > 0 ? setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs) : null
    child.on('error', (failure) => { if (timeout) clearTimeout(timeout); reject(failure) })
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout)
      if (timedOut) reject(new Error('Loading the Git diff timed out.'))
      else if (code !== 0) reject(new Error(error.trim() || `Git exited with code ${code}.`))
      else resolve(chunks.join(''))
    })
  })
}

async function parallelMap<T, R>(values: T[], limit: number, work: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++
      results[index] = await work(values[index])
    }
  }))
  return results
}

async function untrackedDiff(cwd: string, path: string): Promise<FileDiff | null> {
  if (isReviewBinaryPath(path)) return null
  const absolute = resolve(cwd, path)
  const file = await open(absolute, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (!file) return null
  try {
    const sample = Buffer.alloc(8192)
    const { bytesRead } = await file.read(sample, 0, sample.length, 0)
    if (looksBinary(sample.subarray(0, bytesRead))) return null
    const diff = makeDiff(absolute, null, await file.readFile('utf8'))
    return isReviewTextDiff(diff) ? diff : null
  } finally {
    await file.close()
  }
}

function decodedPatchPath(path: string): string {
  // core.quotePath=false still escapes control characters and backslashes.
  return path.replace(/\\([0-7]{1,3}|[abfnrtv\\"])/g, (_, escape: string) => {
    const escapes: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"' }
    return /^[0-7]/.test(escape) ? String.fromCharCode(parseInt(escape, 8)) : escapes[escape]
  })
}

function hunkBody(parsed: ReturnType<typeof parsePatch>[number]): string {
  return parsed.hunks.map((hunk) => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}`).join('\n')
}

async function trackedDiffBatch(cwd: string, args: string[], paths: string[]): Promise<FileDiff[]> {
  const patch = await git(cwd, [...args, '--patch', '--', ...paths.map((path) => `:(literal)${path}`)], 0)
  const files = new Map<string, FileDiff>()
  const expected = new Set(paths)
  for (const parsed of parsePatch(patch)) {
    const name = parsed.newFileName && parsed.newFileName !== '/dev/null' ? parsed.newFileName.replace(/^b\//, '') : parsed.oldFileName?.replace(/^a\//, '')
    if (!name) continue
    const path = decodedPatchPath(name)
    if (!expected.has(path)) continue
    files.set(path, diffFromUnified(resolve(cwd, path), hunkBody(parsed), {
      created: parsed.oldFileName === '/dev/null', deleted: parsed.newFileName === '/dev/null'
    }))
  }
  // Empty files and mode-only changes can omit ---/+++ filename headers.
  for (const path of paths) {
    if (files.has(path)) continue
    const section = await git(cwd, [...args, '--patch', '--', `:(literal)${path}`], 0)
    const parsed = parsePatch(section)[0]
    files.set(path, diffFromUnified(resolve(cwd, path), parsed ? hunkBody(parsed) : '', {
      created: /^new file mode /m.test(section), deleted: /^deleted file mode /m.test(section)
    }))
  }
  return paths.map((path) => files.get(path)!).filter(isReviewTextDiff)
}

export async function initReviewRepository(cwd: string): Promise<void> {
  if ((await gitInfo(cwd)).isRepo) return
  await git(cwd, ['init'])
  if (!(await gitInfo(cwd)).isRepo) throw new Error('Could not initialize the Git repository.')
}

export async function reviewCommits(cwd: string): Promise<ReviewCommit[]> {
  if (!(await gitInfo(cwd)).isRepo) return []
  const refs = await git(cwd, ['for-each-ref', '--count=1', '--format=%(objectname)'])
  const head = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')
  if (!head.trim() && !refs.trim()) return []
  const output = await git(cwd, ['log', '--all', '-100', '--date-order', '--format=%H%x00%h%x00%s%x00%an%x00%aI'])
  return output.trim().split('\n').filter(Boolean).map((line) => {
    const [hash, shortHash, subject, author, date] = line.split('\0')
    return { hash, shortHash, subject, author, date }
  })
}

async function loadReview(cwd: string, options?: ReviewOptions): Promise<{ isRepo: boolean; diffs: FileDiff[] }> {
  if (!(await gitInfo(cwd)).isRepo) return { isRepo: false, diffs: [] }
  const mode = options?.mode ?? 'uncommitted'
  const flags = ['--relative', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--no-quiet', '--no-exit-code', '--src-prefix=a/', '--dst-prefix=b/']
  let args: string[]
  if (mode === 'commit') {
    const ref = options?.commit?.trim()
    if (!ref || ref.startsWith('-')) throw new Error('Select a commit.')
    const hash = (await git(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim()
    args = ['show', '--format=', '--root', '--diff-merges=first-parent', ...flags, hash, '--', '.']
  } else if (mode === 'unstaged') args = ['diff', ...flags, '--', '.']
  else if (mode === 'staged') args = ['diff', '--cached', ...flags, '--', '.']
  else if (mode === 'branch') {
    // Everything the branch adds to its base, committed or not, without what the base gained since.
    const base = options?.base?.trim()
    if (!base || base.startsWith('-')) throw new Error('This branch has no base to compare with.')
    args = ['diff', (await git(cwd, ['merge-base', '--end-of-options', base, 'HEAD'])).trim(), ...flags, '--', '.']
  } else if (mode === 'uncommitted') {
    const head = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')
    // An unborn branch compares the working tree with Git's empty tree.
    const base = head.trim() || (await git(cwd, ['hash-object', '-w', '-t', 'tree', '--', process.platform === 'win32' ? 'NUL' : '/dev/null'])).trim()
    args = ['diff', base, ...flags, '--', '.']
  } else throw new Error('Unknown review mode.')
  const split = args.indexOf('--')
  const diffArgs = args.slice(0, split)
  const [stats, untracked] = await Promise.all([
    git(cwd, [...diffArgs, '--numstat', '-z', '--', '.'], 0),
    mode === 'uncommitted' || mode === 'unstaged' || mode === 'branch' ? git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.']) : Promise.resolve('')
  ])
  // Discover text files first; do not generate image or binary patches at all.
  const paths = stats.split('\0').flatMap((entry) => {
    const match = entry.match(/^(\d+)\t(\d+)\t([\s\S]+)$/)
    return match && !isReviewBinaryPath(match[3]) ? [match[3]] : []
  })
  const batches: string[][] = []
  let batch: string[] = []
  let bytes = 0
  for (const path of paths) {
    const size = Buffer.byteLength(path) + 16
    if (batch.length && (batch.length >= 64 || bytes + size > 24000)) {
      batches.push(batch)
      batch = []
      bytes = 0
    }
    batch.push(path)
    bytes += size
  }
  if (batch.length) batches.push(batch)
  const [tracked, added] = await Promise.all([
    parallelMap(batches, 2, (paths) => trackedDiffBatch(cwd, diffArgs, paths)),
    parallelMap(untracked.split('\0').filter((path) => path && !isReviewBinaryPath(path)), 4, (path) => untrackedDiff(cwd, path))
  ])
  return { isRepo: true, diffs: [...tracked.flat(), ...added.filter((diff): diff is FileDiff => diff !== null)] }
}

const pendingReviews = new Map<string, Promise<{ isRepo: boolean; diffs: FileDiff[] }>>()

export function readReview(cwd: string, options?: ReviewOptions): Promise<{ isRepo: boolean; diffs: FileDiff[] }> {
  const key = JSON.stringify([resolve(cwd), options?.mode ?? 'uncommitted', options?.commit ?? '', options?.base ?? ''])
  const pending = pendingReviews.get(key)
  if (pending) return pending
  const job: Promise<{ isRepo: boolean; diffs: FileDiff[] }> = loadReview(cwd, options).finally(() => {
    if (pendingReviews.get(key) === job) pendingReviews.delete(key)
  })
  pendingReviews.set(key, job)
  return job
}
