import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { GitInfo, WorktreeInfo } from '@shared/types'
import { exists, newId, run, slugify } from '../util'

async function git(cwd: string, args: string[], timeout = 20000): Promise<{ ok: boolean; out: string; err: string }> {
  const result = await run('git', args, { cwd, timeout })
  return { ok: result.code === 0, out: result.stdout.trim(), err: result.stderr.trim() }
}

export async function gitInfo(path: string): Promise<GitInfo> {
  if (!(await exists(path))) return { isRepo: false, branch: null }
  const inside = await git(path, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.out !== 'true') return { isRepo: false, branch: null }
  const branch = await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return { isRepo: true, branch: branch.ok ? branch.out : null }
}

/** What the review panel needs to pick its main Git action. */
export async function gitState(cwd: string): Promise<{ isRepo: boolean; dirty: boolean; hasRemote: boolean }> {
  if (!(await gitInfo(cwd)).isRepo) return { isRepo: false, dirty: false, hasRemote: false }
  const [status, remotes] = await Promise.all([git(cwd, ['status', '--porcelain']), git(cwd, ['remote'])])
  return { isRepo: true, dirty: status.ok && status.out !== '', hasRemote: remotes.ok && remotes.out !== '' }
}

/**
 * Pushes the current branch. A branch without an upstream goes to origin, or the
 * only remote, and becomes tracked there. Never prompts for credentials.
 */
export async function pushBranch(cwd: string): Promise<{ branch: string; remote: string }> {
  const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch.ok || branch.out === 'HEAD') throw new Error('No branch is checked out, so there is nothing to push.')
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  const push = async (args: string[]): Promise<void> => {
    const result = await run('git', ['push', ...args], { cwd, timeout: 120000, env })
    if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'git push failed.')
  }
  const upstream = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  if (upstream.ok && upstream.out) {
    await push([])
    return { branch: branch.out, remote: upstream.out.split('/')[0] }
  }
  const remotes = (await git(cwd, ['remote'])).out.split('\n').filter(Boolean)
  const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : null
  if (!remote) throw new Error(remotes.length ? 'This branch has no upstream and there are several remotes. Set an upstream first.' : 'This repository has no remote to push to.')
  await push(['-u', remote, branch.out])
  return { branch: branch.out, remote }
}

/**
 * Creates an isolated checkout for a chat on its own branch, under
 * ~/.galaxy/worktrees/<project>/<slug>. Fails if the repo has no commits yet.
 */
export async function createWorktree(projectPath: string, hint: string): Promise<WorktreeInfo> {
  const head = await git(projectPath, ['rev-parse', '--verify', 'HEAD'])
  if (!head.ok) throw new Error('This repository has no commits yet, so a worktree cannot be created. Commit once or use Local.')

  const base = await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const slug = `${slugify(hint, 28)}-${newId().slice(0, 5).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`
  const branch = `galaxy/${slug}`
  const root = join(homedir(), '.galaxy', 'worktrees', basename(projectPath))
  const path = join(root, slug)
  await mkdir(root, { recursive: true })

  const added = await git(projectPath, ['worktree', 'add', '-b', branch, path, 'HEAD'], 60000)
  if (!added.ok) throw new Error(`git worktree add failed: ${added.err || added.out}`)
  return { path, branch, baseBranch: base.ok && base.out !== 'HEAD' ? base.out : null }
}

export async function removeWorktree(projectPath: string, worktree: WorktreeInfo): Promise<void> {
  if (!(await exists(projectPath))) return
  await git(projectPath, ['worktree', 'remove', '--force', worktree.path], 60000)
  // The branch is kept when it carries commits the base does not have.
  const unmerged = await git(projectPath, ['log', '--oneline', `HEAD..${worktree.branch}`])
  if (unmerged.ok && unmerged.out === '') await git(projectPath, ['branch', '-D', worktree.branch])
}
