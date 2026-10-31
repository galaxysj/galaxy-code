import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { GitInfo, WorktreeInfo, WorktreeMergeResult, WorktreeMergeStrategy, WorktreeStatus } from '@shared/types'
import { CommitMessageModel, usableUtilityModels } from '@shared/models'
import { store } from '../store'
import { exists, newId, run, slugify } from '../util'
import { runUtilityModel } from './utilityModel'

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

/** Instant commit: stage everything, have the commit message model write the message, commit, and push when asked. */
export async function instantCommit(cwd: string, push: boolean): Promise<{ hash: string; message: string; pushed: { branch: string; remote: string } | null }> {
  // An account model falls back to the default when its account is switched off.
  const model = usableUtilityModels(CommitMessageModel, store.settings.accounts).find((entry) => entry.ID === store.settings.commitMessageModelId) ?? CommitMessageModel[0]
  if (model.Subscription === 'Default' && !store.openRouterKey) throw new Error('Instant commit writes the message with an OpenRouter model. Add an OpenRouter key in Settings first.')
  const added = await git(cwd, ['add', '-A'])
  if (!added.ok) throw new Error(`git add failed:\n${added.err || added.out}`)
  const stat = await git(cwd, ['diff', '--cached', '--stat'])
  if (!stat.ok) throw new Error(`git diff failed:\n${stat.err}`)
  if (!stat.out) throw new Error('There are no changes to commit.')
  const diff = await run('git', ['diff', '--cached', '--no-color', '--no-ext-diff'], { cwd, timeout: 30000 })
  const recent = await git(cwd, ['log', '-10', '--format=%s'])
  const system = 'Write a git commit message for the staged changes below. A subject line of at most 72 characters in the imperative mood, then, only if the change needs it, a blank line and a short body. Match the style of the recent subjects when there are any. Reply with the message only, no quotes or code fences.'
  const prompt = `Recent subjects:\n${recent.ok && recent.out ? recent.out : '(none)'}\n\nStat:\n${stat.out}\n\nDiff:\n${diff.stdout.slice(0, 40000)}`
  const reply = await runUtilityModel(model, system, prompt, { cwd, signal: AbortSignal.timeout(model.Subscription === 'Default' ? 60000 : 120000) })
  const message = reply.trim().replace(/^```\w*\n?|\n?```$/g, '').trim()
  if (!message) throw new Error(`${model.DisplayName} returned an empty commit message.`)
  const committed = await run('git', ['commit', '-m', message], { cwd, timeout: 120000 })
  if (committed.code !== 0) throw new Error(`git commit failed:\n${(committed.stderr || committed.stdout).trim()}`)
  const hash = (await git(cwd, ['rev-parse', '--short', 'HEAD'])).out
  return { hash, message, pushed: push ? await pushBranch(cwd) : null }
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

export async function worktreeStatus(projectPath: string, worktree: WorktreeInfo): Promise<WorktreeStatus> {
  const [changes, project, counts] = await Promise.all([
    git(worktree.path, ['status', '--porcelain']),
    git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    worktree.baseBranch ? git(projectPath, ['rev-list', '--left-right', '--count', `${worktree.baseBranch}...${worktree.branch}`]) : null
  ])
  const [behind, ahead] = counts?.ok ? counts.out.split(/\s+/).map(Number) : [0, 0]
  return {
    branch: worktree.branch,
    baseBranch: worktree.baseBranch,
    ahead,
    behind,
    dirty: changes.ok && changes.out !== '',
    projectBranch: project.ok && project.out !== 'HEAD' ? project.out : null
  }
}

/** Uncommitted work goes along with a merge. The commit message model writes the message when it can. */
async function commitWorktree(worktree: WorktreeInfo): Promise<void> {
  if ((await git(worktree.path, ['status', '--porcelain'])).out === '') return
  try {
    await instantCommit(worktree.path, false)
  } catch {
    const added = await git(worktree.path, ['add', '-A'])
    if (!added.ok) throw new Error(`git add failed:\n${added.err || added.out}`)
    const committed = await git(worktree.path, ['commit', '-m', `Changes from ${worktree.branch}`], 120000)
    if (!committed.ok) throw new Error(`git commit failed:\n${committed.err || committed.out}`)
  }
}

const conflictedFiles = async (cwd: string): Promise<string[]> => (await git(cwd, ['diff', '--name-only', '--diff-filter=U'])).out.split('\n').filter(Boolean)

/**
 * Merges a worktree's branch into its base in the project folder, committing what is uncommitted first. A merge that
 * conflicts is undone and reports the files, so the project folder is never left half merged. Squash leaves the branch
 * on the new base commit, so a later merge from this chat does not bring the same work twice.
 */
export async function mergeWorktree(projectPath: string, worktree: WorktreeInfo, strategy: WorktreeMergeStrategy): Promise<WorktreeMergeResult> {
  const base = worktree.baseBranch
  if (!base) throw new Error('This worktree started from a detached HEAD, so it has no branch to merge into.')
  const project = await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (project.out !== base) throw new Error(`The project folder is on ${project.out}. Switch it to ${base} to merge.`)
  await commitWorktree(worktree)
  const commits = await git(projectPath, ['log', '--format=%s', '--reverse', `${base}..${worktree.branch}`])
  if (!commits.ok) throw new Error(commits.err || 'Could not read the branch.')
  if (commits.out === '') throw new Error(`${worktree.branch} has nothing to merge into ${base}.`)

  const merged = await git(projectPath, strategy === 'squash' ? ['merge', '--squash', worktree.branch] : ['merge', '--no-ff', '--no-edit', worktree.branch], 120000)
  if (!merged.ok) {
    const conflicts = await conflictedFiles(projectPath)
    if (!conflicts.length) throw new Error(merged.err || merged.out || 'git merge failed.')
    await git(projectPath, strategy === 'squash' ? ['reset', '--merge'] : ['merge', '--abort'])
    return { merged: false, hash: null, conflicts }
  }
  if (strategy === 'squash') {
    const subjects = commits.out.split('\n')
    const body = subjects.length > 1 ? ['-m', subjects.map((subject) => `- ${subject}`).join('\n')] : []
    const committed = await git(projectPath, ['commit', '-m', subjects.length > 1 ? `Merge ${worktree.branch}` : subjects[0], ...body], 120000)
    if (!committed.ok) {
      await git(projectPath, ['reset', '--merge'])
      throw new Error(`git commit failed:\n${committed.err || committed.out}`)
    }
    await git(worktree.path, ['reset', '--hard', base])
  }
  return { merged: true, hash: (await git(projectPath, ['rev-parse', '--short', 'HEAD'])).out, conflicts: [] }
}

/** Brings the base's new commits into the worktree's branch. A conflict is undone and reports the files. */
export async function updateWorktree(worktree: WorktreeInfo): Promise<WorktreeMergeResult> {
  const base = worktree.baseBranch
  if (!base) throw new Error('This worktree started from a detached HEAD, so it has no base branch.')
  await commitWorktree(worktree)
  const merged = await git(worktree.path, ['merge', '--no-edit', base], 120000)
  if (!merged.ok) {
    const conflicts = await conflictedFiles(worktree.path)
    if (!conflicts.length) throw new Error(merged.err || merged.out || 'git merge failed.')
    await git(worktree.path, ['merge', '--abort'])
    return { merged: false, hash: null, conflicts }
  }
  return { merged: true, hash: (await git(worktree.path, ['rev-parse', '--short', 'HEAD'])).out, conflicts: [] }
}
