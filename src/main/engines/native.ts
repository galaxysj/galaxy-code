import { readFile } from 'node:fs/promises'
import type { Attachment, Effort } from '@shared/types'
import { buildSystemPrompt, gatherContext } from '../agent/prompt'
import { TurnWriter, type Session, type Turn } from '../agent/session'
import {
  complete,
  streamChat,
  type ChatContentPart,
  type ChatMessage,
  type ChatToolCall
} from '../services/openrouter'
import { ALL_TOOLS, mcpTools, runTool, toolsForSubagent, toSpecs, type ToolDef, type ToolEnv } from '../tools'
import type { ToolImage } from '../tools/types'
import { isImagePath, truncateEnd, truncateMiddle } from '../util'

const MAX_STEPS = 250
const MAX_TOOL_RESULT = 60_000
/** Prompt size at which older history is folded into a summary. */
const COMPACT_AT_TOKENS = 180_000

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

    const result = await streamChat({
      model: turn.model.id,
      messages: [{ role: 'system', content: options.system }, ...options.messages],
      tools: specs,
      effort: options.effort,
      fast: turn.fast && turn.model.fastMode,
      signal,
      onText: (delta) => writer.text(delta),
      onReasoning: (delta) => writer.reasoning(delta)
    })
    writer.end()

    if (result.usage) {
      session.addUsage(result.usage.inputTokens, result.usage.outputTokens, result.usage.cost, env.parentId ? undefined : result.usage.inputTokens)
    }

    const assistant: ChatMessage = { role: 'assistant', content: result.content || null }
    if (result.toolCalls.length) assistant.tool_calls = result.toolCalls
    if (result.reasoningDetails.length) assistant.reasoning_details = result.reasoningDetails
    options.messages.push(assistant)
    if (result.content) finalText = result.content

    if (result.toolCalls.length === 0) {
      if (session.team?.hasRunning() && session.agentId === 'main') {
        await session.team.wait()
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
        return
      }
      const run = await runTool(tools, env, call.function.name, args.value)
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
      let content = truncateMiddle(outcome?.text ?? '[Interrupted before this tool finished]', MAX_TOOL_RESULT)
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

    if (options.allowCompaction && result.usage && result.usage.inputTokens > COMPACT_AT_TOKENS) {
      const compacted = await compact(session, turn.model.id, options.messages, signal)
      options.messages.splice(0, options.messages.length, ...compacted)
    }

    if (step === options.maxSteps - 1) {
      session.notice('info', `Stopped after ${options.maxSteps} steps. Send a message to continue.`, env.parentId)
    }
  }
  return finalText
}

/** Runs a turn against OpenRouter (or the BYOK endpoint) with Galaxy Code's own tools. */
export async function runNative(session: Session, turn: Turn): Promise<void> {
  const ctx = await gatherContext(session, { permissionMode: turn.permissionMode, modelName: turn.model.name, ultra: turn.ultra })
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
      tools: [...(session.agentId === 'main' ? ALL_TOOLS : toolsForSubagent('general')), ...mcpTools()],
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
