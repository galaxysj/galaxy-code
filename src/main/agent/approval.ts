import { AutoApprovalModel } from '@shared/models'
import { readFile } from 'node:fs/promises'
import type { PermissionMode, ToolItem, ToolKind } from '@shared/types'
import { decideRisk, MissingKeyError } from '../services/openrouter'
import { makeDiff } from '../tools/diff'
import { previewEditPatch } from '../tools/patch'
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
