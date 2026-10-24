import type { PermissionMode, SkillInfo, ToolKind, ToolMeta } from '@shared/types'
import type { GateRequest } from '../agent/approval'
import type { Session } from '../agent/session'

export interface ToolImage {
  mime: string
  base64: string
}

export interface ToolResult {
  text: string
  pending?: boolean
  images?: ToolImage[]
  meta?: ToolMeta
  isError?: boolean
  /** Shown in the UI instead of `text` when the model-facing text is noisy. */
  display?: string
}

export interface SubagentRequest {
  description: string
  prompt: string
  type: string
  itemId: string
  signal: AbortSignal
}

export interface ToolContext {
  session: Session
  cwd: string
  signal: AbortSignal
  permissionMode: PermissionMode
  /** Timeline item of this call. */
  itemId: string
  /** Agent tool item that owns this call, when run by a subagent. */
  parentId?: string
  skills: SkillInfo[]
  /** Streams partial output into the item. */
  onOutput(delta: string): void
  /** Present only where nested agents can be run. */
  spawnSubagent?(request: SubagentRequest): Promise<string>
}

export interface ToolPresentation {
  title: string
  detail?: string
  meta?: ToolMeta
}

export interface ToolDef {
  name: string
  kind: ToolKind
  description: string
  parameters: Record<string, unknown>
  /** Safe to run alongside other calls from the same model turn. */
  parallel?: boolean
  present(input: Record<string, unknown>, ctx: Pick<ToolContext, 'cwd' | 'skills'>): ToolPresentation
  /** Returns what needs approval, or null when the call is always allowed. */
  approval?(input: Record<string, unknown>, ctx: Pick<ToolContext, 'cwd'>): Omit<GateRequest, 'itemId' | 'kind'> | null
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

export class ToolInputError extends Error {}

export function str(input: Record<string, unknown>, key: string, required: true): string
export function str(input: Record<string, unknown>, key: string, required?: false): string | undefined
export function str(input: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = input[key]
  if (value === undefined || value === null || value === '') {
    if (required) throw new ToolInputError(`Missing required parameter: ${key}`)
    return undefined
  }
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  throw new ToolInputError(`Parameter ${key} must be a string`)
}

export function num(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key]
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) throw new ToolInputError(`Parameter ${key} must be a number`)
  return parsed
}

export function bool(input: Record<string, unknown>, key: string): boolean {
  const value = input[key]
  return value === true || value === 'true' || value === 1
}

export function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`
}
