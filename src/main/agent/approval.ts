import { AutoApprovalModel } from '@shared/models'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { app } from 'electron'
import type { PermissionMode, ToolItem, ToolKind } from '@shared/types'
import { decideRisk, MissingKeyError } from '../services/openrouter'
import { makeDiff } from '../tools/diff'
import { parseEditPatch, patchFiles, previewEditPatch } from '../tools/patch'
import { errorMessage, resolvePath } from '../util'
import type { Session } from './session'

export interface GateRequest {
  itemId: string
  kind: ToolKind
  /** What the model wants to do, in a form the approval model can judge. */
  action: Record<string, unknown>
  /** Key under which the user can allow similar actions for the rest of the chat. */
  sessionKey?: string
  sessionLabel?: string
}

export type GateResult = { allowed: true } | { allowed: false; message: string }

const DENIED = 'The user declined this action.'

/** Prepare the actual proposed patch before displaying a file permission request. */
async function prepareFilePreview(session: Session, request: GateRequest): Promise<void> {
  if (request.kind !== 'edit' && request.kind !== 'create') return
  const item = session.item<ToolItem>(request.itemId)
  if (!item || item.meta?.diffs?.some((diff) => diff.patch)) return
  const input = item.input as Record<string, unknown> | null
  if (!input) return
  if (item.name === 'Edit' && typeof input.patch === 'string') {
    const diffs = await previewEditPatch(input.patch, await session.cwd())
    session.update<ToolItem>(item.id, { meta: { ...item.meta, diffs } })
    return
  }
  const rawPath = input.path ?? input.file_path ?? request.action.file
  if (typeof rawPath !== 'string' || !rawPath) return
  try {
    const path = resolvePath(await session.cwd(), rawPath)
    const before = await readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    let after: string
    if (typeof input.content === 'string') after = input.content
    else if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      if (before === null || !input.old_string || !before.includes(input.old_string)) return
      after = input.replace_all === true || input.replace_all === 'true' || input.replace_all === 1
        ? before.split(input.old_string).join(input.new_string)
        : before.replace(input.old_string, () => input.new_string as string)
    } else return
    session.update<ToolItem>(item.id, { meta: { ...item.meta, diffs: [makeDiff(path, before, after)] } })
  } catch {
    // Permission review must still work when a file cannot be read for preview.
  }
}

function denial(note?: string): GateResult {
  return {
    allowed: false,
    message: note
      ? `${DENIED} They said: ${note}`
      : `${DENIED} Do not retry it or work around it. Continue with what you can do, or ask what they would prefer.`
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Resolve existing ancestors too, so new files under symlinked directories are checked. */
async function physicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error
    const entry = await lstat(path).catch((entryError: NodeJS.ErrnoException) => {
      if (entryError.code !== 'ENOENT') throw entryError
      return null
    })
    if (entry?.isSymbolicLink()) throw error
    return join(await physicalPath(dirname(path)), basename(path))
  }
}

async function workspaceEdit(session: Session, request: GateRequest): Promise<boolean> {
  if (request.kind !== 'edit' && request.kind !== 'create') return false
  try {
    const cwd = await session.cwd()
    const paths: string[] = []
    const collect = (value: Record<string, unknown>): void => {
      for (const key of ['file', 'path', 'file_path', 'notebook_path', 'moveTo']) {
        if (typeof value[key] === 'string' && value[key]) paths.push(value[key] as string)
      }
      if (typeof value.patch === 'string' && value.patch.startsWith('*** Begin Patch')) {
        paths.push(...patchFiles(parseEditPatch(value.patch, cwd), cwd))
      }
    }
    collect(request.action)
    if (Array.isArray(request.action.files)) {
      for (const file of request.action.files) {
        if (file && typeof file === 'object') collect(file as Record<string, unknown>)
      }
    }
    const input = request.action.input
    if (input && typeof input === 'object') collect(input as Record<string, unknown>)
    // Unspecified targets still require approval.
    if (paths.length === 0) return false
    const root = await realpath(cwd)
    for (const path of paths) {
      const absolute = resolvePath(cwd, path)
      if (!inside(cwd, absolute) || !inside(root, await physicalPath(absolute))) return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Places agents read as part of how Galaxy Code works rather than to look at the user's files:
 * memory and skills, background terminal logs, the app's own data, and the agent CLIs' own memory.
 */
function specialRead(path: string): boolean {
  const home = homedir()
  return [
    join(home, '.galaxy'),
    join(tmpdir(), 'galaxy-code'),
    app.getPath('userData'),
    join(home, '.claude', 'skills'),
    join(home, '.codex', 'skills')
  ].some((root) => inside(root, path)) || /[/\\]\.claude[/\\]projects[/\\][^/\\]+[/\\]memory([/\\]|$)/.test(path)
}

/** Reads, searches and listings outside the working directory go through the gate, except the special places above. */
export function outsideReadApproval(cwd: string, rawPath: unknown, tool: string, input: Record<string, unknown>): Omit<GateRequest, 'itemId' | 'kind'> | null {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null
  const path = resolvePath(cwd, rawPath)
  if (inside(cwd, path) || specialRead(path)) return null
  return {
    action: { tool, working_directory: cwd, path, inside_workspace: false, ...input },
    sessionKey: 'read-outside',
    sessionLabel: 'Allow reads outside the project in this chat'
  }
}

/** First words of a shell command, used to group similar commands for "allow in this chat". */
export function commandPrefix(command: string): string {
  const first = command
    .trim()
    .split(/\s*(?:&&|\|\||;|\|)\s*/)[0]
    .replace(/^(?:\w+=\S+\s+)+/, '')
  const words = first.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  const multi = ['git', 'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'docker', 'kubectl', 'gh', 'make', 'npx', 'python', 'python3', 'node', 'uv', 'pip', 'pip3', 'brew', 'swift', 'xcodebuild', 'deno']
  if (multi.includes(words[0]) && words[1] && !words[1].startsWith('-')) {
    if ((words[0] === 'npm' || words[0] === 'pnpm' || words[0] === 'yarn' || words[0] === 'bun') && words[1] === 'run' && words[2]) {
      return words.slice(0, 3).join(' ')
    }
    return words.slice(0, 2).join(' ')
  }
  return words[0]
}

/**
 * Decides whether a tool call may run under the chat's permission mode.
 * Ask: the user approves. Auto: the approval model judges risk and the user is
 * only asked when its deny probability is at least 50%. Full access: everything runs.
 */
export async function gate(session: Session, mode: PermissionMode, request: GateRequest): Promise<GateResult> {
  if (mode === 'full') return { allowed: true }
  if (mode === 'accept-edits' && await workspaceEdit(session, request)) return { allowed: true }
  if (session.isSessionAllowed(request.sessionKey)) return { allowed: true }

  let source: 'ask' | 'auto' = 'ask'
  let reason: string | undefined

  if (mode === 'auto') {
    source = 'auto'
    try {
      const decision = await decideRisk({
        request: session.lastUserText.slice(0, 12000),
        user_requests: session.doc.items.filter((item) => item.kind === 'user').slice(-6).map((item) => ({
          text: item.kind === 'user' ? item.text.slice(0, 6000) : ''
        })),
        workspace: await session.cwd(),
        action_kind: request.kind,
        action: request.action
      }, session.controller?.signal)
      if (session.controller?.signal.aborted || !session.running) return { allowed: false, message: 'Stopped by user.' }
      if (decision.allow) {
        const item = session.item<ToolItem>(request.itemId)
        session.update<ToolItem>(request.itemId, {
          meta: { ...(item?.meta ?? {}), autoApproved: true, autoReason: decision.reason }
        })
        return { allowed: true }
      }
      reason = decision.reason
    } catch (err) {
      if (session.controller?.signal.aborted || !session.running) return { allowed: false, message: 'Stopped by user.' }
      reason =
        err instanceof MissingKeyError
          ? `Auto approval needs an OpenRouter key to reach ${AutoApprovalModel.DisplayName}`
          : `${AutoApprovalModel.DisplayName} could not be reached (${errorMessage(err)})`
    }
  }

  await prepareFilePreview(session, request)
  if (session.controller?.signal.aborted || !session.running) return { allowed: false, message: 'Stopped by user.' }
  const decision = await session.requestApproval(request.itemId, {
    source,
    reason,
    sessionKey: request.sessionKey,
    sessionLabel: request.sessionLabel
  })
  return decision.allowed ? { allowed: true } : denial(decision.note)
}
