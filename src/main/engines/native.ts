import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Attachment, Effort, FileDiff, ToolItem } from '@shared/types'
import { buildSystemPrompt, gatherContext } from '../agent/prompt'
import { TurnWriter, type Session, type Turn } from '../agent/session'
import {
  complete,
  streamChat,
  type ChatContentPart,
  type ChatMessage,
  type ChatToolCall
} from '../services/openrouter'
import { ALL_TOOLS, mcpTools, runTool, toolsForMode, toolsForSubagent, toSpecs, type ToolDef, type ToolEnv } from '../tools'
import type { ToolImage } from '../tools/types'
import { isImagePath, resolvePath, truncateEnd, truncateMiddle } from '../util'
import { basename } from 'node:path'
import { streamedEditInput } from './claude'
import { makeDiff } from '../tools/diff'

const MAX_STEPS = 250
const PLAN_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'
/** Context window for models whose size models.ts does not give. */
const DEFAULT_CONTEXT_WINDOW = 200_000

/** Prompt size at which older history is folded into a summary: 90% of the model's context window. */
export function compactAt(model: { contextWindow?: number; contextOptions?: number[] }, picked?: number | null): number {
  const size = picked && model.contextOptions?.includes(picked) ? picked : model.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  return Math.floor(size * 0.9)
}

async function userMessage(text: string, attachments: Attachment[], vision: boolean): Promise<ChatMessage> {
  if (attachments.length === 0) return { role: 'user', content: text }
  const parts: ChatContentPart[] = []
  const paths: string[] = []
  for (const attachment of attachments) {
    paths.push(attachment.path)
    if (vision && isImagePath(attachment.path)) {
      const data = await readFile(attachment.path).catch(() => null)
      if (data) parts.push({ type: 'image_url', image_url: { url: `data:${attachment.mime};base64,${data.toString('base64')}` } })
    }
  }
  const note = `\n\nAttached files:\n${paths.map((p) => `- ${p}`).join('\n')}`
  return { role: 'user', content: [{ type: 'text', text: (text || 'See the attached files.') + note }, ...parts] }
}

function parseArgs(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!raw.trim()) return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch (err) {
    return { ok: false, error: `Tool arguments were not valid JSON (${(err as Error).message}). Send the call again with well-formed arguments.` }
  }
}

/** A stopped run can leave tool calls without results, which providers reject on the next request. */
function repairHistory(messages: ChatMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue
    const answered = new Set<string>()
    let j = i + 1
    while (j < messages.length && messages[j].role === 'tool') {
      answered.add(messages[j].tool_call_id ?? '')
      j++
    }
    const missing = message.tool_calls.filter((call) => !answered.has(call.id))
    if (missing.length > 0) {
      messages.splice(
        j,
        0,
        ...missing.map((call): ChatMessage => ({ role: 'tool', tool_call_id: call.id, content: '[Interrupted before this tool finished]' }))
      )
    }
  }
}

function transcript(messages: ChatMessage[]): string {
  const lines: string[] = []
  for (const message of messages) {
    const text =
      typeof message.content === 'string'
        ? message.content
        : (message.content ?? []).map((part) => (part.type === 'text' ? part.text : '[image]')).join('\n')
    if (message.role === 'user') lines.push(`USER:\n${truncateMiddle(text, 6000)}`)
    else if (message.role === 'assistant') {
      if (text) lines.push(`ASSISTANT:\n${truncateMiddle(text, 4000)}`)
      for (const call of message.tool_calls ?? []) lines.push(`TOOL CALL ${call.function.name}: ${truncateEnd(call.function.arguments, 800)}`)
    } else if (message.role === 'tool') lines.push(`TOOL RESULT:\n${truncateMiddle(text, 1500)}`)
  }
  return lines.join('\n\n')
}

/** Summarizes a chat's stored history now, as /compact asks. Returns false when there is nothing to fold. */
export async function compactChat(session: Session, modelId: string, signal: AbortSignal): Promise<boolean> {
  const history = (session.doc.engine.history ?? []) as ChatMessage[]
  if (history.length < 2) return false
  const compacted = await compact(session, modelId, history, signal)
  session.doc.engine.history = compacted
  return true
}

async function compact(session: Session, modelId: string, messages: ChatMessage[], signal: AbortSignal): Promise<ChatMessage[]> {
  const summary = await complete(
    modelId,
    [
      {
        role: 'system',
        content:
          'You are compacting the history of a coding-agent session so the agent can continue with a fresh context. Write a handoff that loses nothing needed to finish the job. Cover: what the user asked for and any preferences or corrections they gave, verbatim where wording matters; what has been done, with exact file paths and the nature of each change; what was learned about the codebase; commands that were run and their outcomes; what is in progress right now; what remains. Be specific and complete. Do not address the user.'
      },
      { role: 'user', content: truncateMiddle(transcript(messages), 400_000) }
    ],
    signal
  )
  session.notice('info', 'Earlier conversation was summarized to free up context.')
  return [
    {
      role: 'user',
      content: `This session is continuing from an earlier conversation that was summarized to save context. Summary of everything so far:\n\n${summary}\n\nContinue the work from where it left off.`
    }
  ]
}

interface LoopOptions {
  session: Session
  turn: Turn
  system: string
  /** Conversation without the system message. Mutated in place. */
  messages: ChatMessage[]
  tools: ToolDef[]
  env: ToolEnv
  writer: TurnWriter
  effort: Effort | null
  maxSteps: number
  allowCompaction: boolean
}

/**
 * Live previews of Edit and Create while their arguments stream in: the timeline shows the
 * diff growing, and runTool takes the same item over once the call is complete.
 */
function editPreviews(session: Session, env: ToolEnv): { update(call: ChatToolCall): void; has(id: string): boolean; settle(): Promise<void> } {
  const shown = new Set<string>()
  const last = new Map<string, number>()
  let pending: Promise<void> = Promise.resolve()
  const publish = async (call: ChatToolCall): Promise<void> => {
    const name = call.function.name
    const input = streamedEditInput(call.function.arguments)
    let diffs: FileDiff[] | undefined
    let title = name
    if (name === 'Create' && typeof input.path === 'string' && input.path) {
      const abs = resolvePath(env.cwd, input.path)
      title = `Create ${basename(abs)}`
      diffs = [makeDiff(abs, null, typeof input.content === 'string' ? input.content : '')]
    }
    // An Edit shows its patch as plain text while it is written; the diff appears once it runs.
    const patch = name === 'Edit' && typeof input.patch === 'string' ? input.patch : undefined
    if (!diffs && patch === undefined) return
    const fields = patch !== undefined ? { input: { patch } } : { meta: { ...session.item<ToolItem>(call.id)?.meta, diffs } }
    if (shown.has(call.id)) session.update<ToolItem>(call.id, { title, ...fields })
    else {
      shown.add(call.id)
      session.add<ToolItem>({ id: call.id, kind: 'tool', tool: name === 'Create' ? 'create' : 'edit', name, title, input: {}, status: 'pending', parentId: env.parentId, ...fields })
    }
  }
  return {
    update(call) {
      if (call.function.name !== 'Edit' && call.function.name !== 'Create') return
      const now = Date.now()
      if (now - (last.get(call.id) ?? 0) < 80) return
      last.set(call.id, now)
      const snapshot = { ...call, function: { ...call.function } }
      pending = pending.then(() => publish(snapshot)).catch(() => {})
    },
    has: (id) => shown.has(id),
    settle: () => pending
  }
}

/** The model-tool loop: request, run the tools it asks for, feed results back, until it answers. */
async function loop(options: LoopOptions): Promise<string> {
  const { session, turn, tools, env, writer } = options
  const signal = env.signal
  const specs = toSpecs(tools)
  let finalText = ''

  for (let step = 0; step < options.maxSteps; step++) {
    if (signal.aborted) break
    for (const message of session.team?.read(session.agentId) ?? []) {
      options.messages.push({ role: 'user', content: `Message from agent ${message.from}:\n${message.text}` })
    }

    const previews = editPreviews(session, env)
    const result = await streamChat({
      model: turn.model.id,
      messages: [{ role: 'system', content: options.system }, ...options.messages],
      tools: specs,
      effort: options.effort,
      fast: turn.fast && turn.model.fastMode,
      ultrafast: turn.ultrafast && turn.model.ultrafastMode,
      signal,
      onText: (delta) => writer.text(delta),
      onReasoning: (delta) => writer.reasoning(delta),
      // Thinking and text are over once the model starts writing a tool call.
      onToolCall: (call) => { writer.end(); previews.update(call) }
    })
    writer.end()
    await previews.settle()

    if (result.usage) {
      session.addUsage(result.usage.inputTokens, result.usage.outputTokens, result.usage.cost, env.parentId ? undefined : result.usage.inputTokens)
    }

    const assistant: ChatMessage = { role: 'assistant', content: result.content || null }
    if (result.toolCalls.length) assistant.tool_calls = result.toolCalls
    if (result.reasoningDetails.length) assistant.reasoning_details = result.reasoningDetails
    options.messages.push(assistant)
    if (result.content) finalText = result.content

    if (result.toolCalls.length === 0) {
      // An event that waits for subagents ends the turn instead; the chat listens and resumes when they finish.
      if (session.team?.hasRunning() && session.agentId === 'main' && !session.events.some((event) => event.keepsTeam)) {
        // Stopping the turn leaves the subagents running, so stop waiting for them too.
        await Promise.race([session.team.wait(), new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))])
        if (signal.aborted) break
        continue
      }
      if (result.finishReason === 'length') {
        session.notice('info', 'The response hit the model output limit and was cut off.', env.parentId)
      }
      break
    }

    const outcomes = new Map<string, { text: string; images?: ToolImage[] }>()
    const execute = async (call: ChatToolCall): Promise<void> => {
      const args = parseArgs(call.function.arguments)
      if (!args.ok) {
        outcomes.set(call.id, { text: args.error })
        // A preview for a call whose arguments never parsed ends as a failed attempt.
        if (previews.has(call.id)) session.update<ToolItem>(call.id, { status: 'error', error: args.error, endedAt: Date.now() })
        return
      }
      const run = await runTool(tools, env, call.function.name, args.value, previews.has(call.id) ? call.id : undefined)
      outcomes.set(call.id, { text: run.result.text, images: run.result.images })
    }

    // Consecutive parallel-safe calls run together; anything with side effects runs alone, in order.
    let batch: ChatToolCall[] = []
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return
      const current = batch
      batch = []
      await Promise.all(current.map(execute))
    }
    for (const call of result.toolCalls) {
      const parallel = tools.find((t) => t.name === call.function.name)?.parallel === true
      if (parallel) {
        batch.push(call)
      } else {
        await flush()
        if (signal.aborted) break
        await execute(call)
      }
    }
    await flush()

    const images: ChatContentPart[] = []
    for (const call of result.toolCalls) {
      const outcome = outcomes.get(call.id)
      // Results arrive already cut where a tool cuts them (Bash, Glob, Grep); the rest are sent whole.
      let content = outcome?.text ?? '[Interrupted before this tool finished]'
      if (outcome?.images?.length) {
        if (turn.model.vision) {
          images.push({ type: 'text', text: `Image output of the ${call.function.name} call:` })
          for (const image of outcome.images) images.push({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } })
        } else {
          content += '\n[An image was produced, but this model cannot view images.]'
        }
      }
      options.messages.push({ role: 'tool', tool_call_id: call.id, content })
    }
    if (images.length) options.messages.push({ role: 'user', content: images })

    if (signal.aborted) break

    if (options.allowCompaction && result.usage && result.usage.inputTokens >= compactAt(turn.model, session.chat.context)) {
      const compacted = await compact(session, turn.model.id, options.messages, signal)
      options.messages.splice(0, options.messages.length, ...compacted)
    }

    if (step === options.maxSteps - 1) {
      session.notice('info', `Stopped after ${options.maxSteps} steps. Send a message to continue.`, env.parentId)
    }
  }
  return finalText
}

/** Eight random lowercase letters and digits that keep plan file names unique. */
function planId(): string {
  return Array.from(randomBytes(8), (byte) => PLAN_ID_CHARS[byte % PLAN_ID_CHARS.length]).join('')
}

/** Runs a turn against OpenRouter (or the BYOK endpoint) with Galaxy Code's own tools. */
export async function runNative(session: Session, turn: Turn): Promise<void> {
  const ctx = await gatherContext(session, { permissionMode: turn.permissionMode, modelName: turn.model.name, ultra: turn.ultra && !turn.mode, mode: turn.mode, planId: turn.mode === 'plan' ? planId() : undefined })
  const history = (session.doc.engine.history ?? []) as ChatMessage[]
  session.doc.engine.history = history
  repairHistory(history)
  history.push(await userMessage(turn.text, turn.attachments, turn.model.vision))

  const env: ToolEnv = {
    session,
    cwd: ctx.cwd,
    signal: turn.signal,
    permissionMode: turn.permissionMode,
    skills: ctx.skills
  }
  if (session.team) env.spawnSubagent = (request) => session.team!.spawn(request, session)

  const writer = new TurnWriter(session)
  try {
    await loop({
      session,
      turn,
      system: buildSystemPrompt(ctx, turn.mentions),
      messages: history,
      // Multitask keeps every tool; its system prompt limits main to delegating.
      tools: turn.mode === 'ask' || turn.mode === 'plan' ? toolsForMode(turn.mode) : [...(session.agentId === 'main' ? ALL_TOOLS : toolsForSubagent('general')), ...mcpTools()],
      env,
      writer,
      effort: turn.effort,
      maxSteps: MAX_STEPS,
      allowCompaction: true
    })
  } finally {
    writer.end()
    repairHistory(history)
  }
}
