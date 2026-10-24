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
