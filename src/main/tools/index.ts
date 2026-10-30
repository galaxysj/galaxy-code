import { mkdir, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentMode, ToolItem, ToolKind } from '@shared/types'
import { gate } from '../agent/approval'
import { mcp, type McpTool } from '../services/mcp'
import type { ChatToolSpec } from '../services/openrouter'
import { errorMessage, isAbortError, oneLine } from '../util'

/** Longer tool results are saved to a temporary file, and the agent gets only their beginning. */
const MAX_RESULT = 30_000
const RESULT_PREVIEW = 2_000
import { editTool, globTool, grepTool, listTool, readTool } from './fs'
import {
  askTool,
  browserTool,
  listTabsTool,
  imageGenerationTool,
  memoryTool,
  openTool,
  presentTool,
  taskTool,
  webFetchTool,
  webSearchTool
} from './galaxy'
import { parseEditPatch, patchFiles } from './patch'
import { eventTool, waitTool } from './events'
import { lintTool } from './lint'
import { bashTool } from './shell'
import { str, ToolInputError, type ToolContext, type ToolDef, type ToolResult } from './types'

export const SUBAGENT_TYPES = {
  general: 'Full tool access. For self-contained pieces of work: implementing a module, fixing an isolated bug, running and repairing tests.',
} as const

export const agentTool: ToolDef = {
  name: 'Agent',
  kind: 'agent',
  parallel: true,
  description: `Start a subagent that works on its own and reports back. It begins with no knowledge of this conversation, so the prompt must stand alone: say what to do, what is already known, which files matter, and what to return. Its report comes back to you, not to the user. Call several in one turn to run them in parallel on independent work.

Types:
${Object.entries(SUBAGENT_TYPES)
  .map(([name, text]) => `- ${name}: ${text}`)
  .join('\n')}`,
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Three to six words naming the job.' },
      prompt: { type: 'string', description: 'Complete, self-contained instructions for the subagent.' },
    },
    required: ['description', 'prompt']
  },
  present(input) {
    return {
      title: oneLine(String(input.description ?? 'Subagent'), 80),
      detail: String(input.prompt ?? ''),
      meta: { agentType: String(input.type ?? 'general') }
    }
  },
  async execute(input, ctx) {
    if (!ctx.spawnSubagent) throw new Error('Subagents cannot start their own subagents')
    const report = await ctx.spawnSubagent({
      description: str(input, 'description') ?? 'Subagent',
      prompt: str(input, 'prompt', true),
      type: 'general',
      itemId: ctx.itemId,
      signal: ctx.signal
    })
    return { text: report, pending: true }
  }
}

export const messageTool: ToolDef = {
  name: 'Message', kind: 'other',
  description: 'Coordinate agents. list returns IDs; send delivers text to main or a running agent; read drains your inbox; wait collects final reports. Main must wait for workers before its final answer. Workers may wait only for their own children.',
  parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'send', 'read', 'wait'] }, to: { type: 'string' }, text: { type: 'string' } }, required: ['action'] },
  present(input) { return { title: input.action === 'send' ? `Messaged to ${input.to}` : `Message · ${input.action}` } },
  async execute(input, ctx) {
    const team = ctx.session.team
    if (!team) throw new Error('No active agent team.')
    switch (str(input, 'action', true)) {
      case 'list': return { text: team.list() }
      case 'read': return { text: JSON.stringify(team.read(ctx.session.agentId)) }
      case 'send': {
        const to = str(input, 'to', true)
        const recipientName = team.name(to)
        ctx.session.update<ToolItem>(ctx.itemId, { title: `Messaged to ${recipientName}`, meta: { recipientName } })
        team.send(ctx.session.agentId, to, str(input, 'text', true))
        return { text: 'Message delivered to the agent inbox.', meta: { recipientName } }
      }
      case 'wait': return { text: await team.wait(str(input, 'to'), ctx.session.agentId) }
      default: throw new ToolInputError('Unknown Message action.')
    }
  }
}

const EXPLORE_TOOLS: ToolDef[] = [readTool, grepTool, globTool, listTool, lintTool, waitTool, webSearchTool, webFetchTool]

/** Every built-in tool, in the order the model sees them. */
export const ALL_TOOLS: ToolDef[] = [
  ...EXPLORE_TOOLS,
  bashTool,
  eventTool,
  editTool,
  browserTool,
  agentTool,
  listTabsTool,
  messageTool,
  askTool,
  taskTool,
  presentTool,
  openTool,
  memoryTool,
  imageGenerationTool
]

/** Tools Galaxy Code lends to account CLIs. */
export const BRIDGE_TOOLS: ToolDef[] = [agentTool, messageTool, editTool, lintTool, waitTool, eventTool, browserTool, listTabsTool, askTool, taskTool, presentTool, openTool, memoryTool, imageGenerationTool]

/** Where Plan mode keeps its plans: in the user's home, never inside the project. */
export const PLANS_DIR = join(homedir(), '.galaxy', 'plans')

function planPaths(tool: ToolDef, input: Record<string, unknown>, cwd: string): string[] {
  return patchFiles(parseEditPatch(str(input, 'patch', true), cwd), cwd)
}

/** Edit limited to Markdown files directly inside ~/.galaxy/plans. Those writes need no approval. */
function planOnly(tool: ToolDef): ToolDef {
  return {
    ...tool,
    description: `${tool.description}\n\nPlan mode: paths resolve inside ${PLANS_DIR}/, and only Markdown files directly in it can be written, such as add-login.md.`,
    approval: undefined,
    async execute(input, ctx) {
      // Plans live outside the project, so relative paths resolve against the plans folder.
      const paths = planPaths(tool, input, PLANS_DIR)
      const outside = paths.filter((path) => dirname(path) !== PLANS_DIR || !/\.md$/i.test(path))
      if (outside.length) throw new Error(`Plan mode can only write Markdown files in ${PLANS_DIR}/. Not allowed: ${outside.join(', ')}`)
      await mkdir(PLANS_DIR, { recursive: true })
      const result = await tool.execute(input, { ...ctx, cwd: PLANS_DIR })
      const plan = paths.at(-1)
      if (plan && ctx.session.agentId === 'main') ctx.session.emitUi({ type: 'open-file', chatId: ctx.session.id, path: plan })
      return result
    }
  }
}

/** Ask answers from what it can read. Plan reads and writes only its plan files. */
export function toolsForMode(mode: Exclude<AgentMode, 'multitask'>): ToolDef[] {
  if (mode === 'ask') return [...EXPLORE_TOOLS, askTool]
  return [...EXPLORE_TOOLS, planOnly(editTool), askTool]
}

export function toolsForSubagent(_type: string): ToolDef[] {
  return ALL_TOOLS.filter((tool) => tool.kind !== 'ask')
}

function mcpAsTool(tool: McpTool): ToolDef {
  const schema = (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} }
  const properties = (schema.properties ?? {}) as Record<string, unknown>
  // Keep the server's own arguments intact, even if it already uses this name.
  let titleKey = '_title'
  while (Object.prototype.hasOwnProperty.call(properties, titleKey)) titleKey = `_${titleKey}`
  const argumentsOf = (input: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(input).filter(([key]) => key !== titleKey))
  return {
    name: tool.qualified,
    kind: 'mcp',
    description: `${tool.description || `${tool.name} from the ${tool.server} MCP server.`}\nProvide ${titleKey} with a short, user-facing action title for this call's tool log.`,
    parameters: {
      ...schema,
      properties: {
        ...properties,
        [titleKey]: { type: 'string', description: 'Short action title displayed in the tool log, for example "Find the project notes". Display only; not sent to the MCP server.', maxLength: 120 }
      }
    },
    present(input) {
      const preview = oneLine(JSON.stringify(argumentsOf(input)), 120)
      const rawTitle = input[titleKey]
      const title = typeof rawTitle === 'string' ? oneLine(rawTitle.trim(), 120) : ''
      return { title: title || `${tool.server}: ${tool.name}`, detail: preview === '{}' ? undefined : preview, meta: { server: tool.server } }
    },
    approval(input) {
      if (tool.readOnly) return null
      return {
        action: { tool: `MCP ${tool.server}/${tool.name}`, description: tool.description.slice(0, 400), arguments: argumentsOf(input) },
        sessionKey: `mcp:${tool.qualified}`,
        sessionLabel: `Always allow ${tool.name} in this chat`
      }
    },
    async execute(input, ctx) {
      const result = await mcp.call(tool, argumentsOf(input), ctx.signal)
      return { text: result.text || '(empty result)', images: result.images, isError: result.isError }
    }
  }
}

export function mcpTools(): ToolDef[] {
  return mcp.tools().map(mcpAsTool)
}

export function toSpecs(tools: ToolDef[]): ChatToolSpec[] {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  }))
}

export type ToolEnv = Omit<ToolContext, 'itemId' | 'onOutput'>

export interface ToolRun {
  result: ToolResult
  itemId: string
  /** With `defer`, records the call's end on the timeline; until then the item stays in progress. */
  finish?: () => void
}

/**
 * Runs one tool call end to end: puts it on the timeline, clears it with the
 * permission gate, executes it, and records the outcome. Never throws for tool
 * failures, the error text goes back to the model so it can adapt.
 */
export async function runTool(
  tools: ToolDef[],
  env: ToolEnv,
  name: string,
  rawInput: unknown,
  itemId?: string,
  defer = false
): Promise<ToolRun> {
  const { session } = env
  const tool = tools.find((t) => t.name === name)
  const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? (rawInput as Record<string, unknown>) : {}

  if (!tool) {
    const item = session.add<ToolItem>({
      kind: 'tool',
      tool: 'other',
      name,
      title: name,
      input,
      status: 'error',
      error: 'Unknown tool',
      parentId: env.parentId,
      endedAt: Date.now()
    })
    return {
      itemId: item.id,
      result: { text: `Unknown tool "${name}". Available tools: ${tools.map((t) => t.name).join(', ')}`, isError: true }
    }
  }

  // Models sometimes skip required fields, such as Bash's description that titles the row.
  // Send the call back before it reaches the timeline, so the retry is the only row the user sees.
  const required = ((tool.parameters as { required?: string[] }).required ?? []).filter((key) => input[key] === undefined)
  if (required.length) {
    // Drop a streamed preview too, so only the retried call shows.
    if (itemId && session.item(itemId)) session.replaceItems(session.doc.items.filter((entry) => entry.id !== itemId))
    return { itemId: '', result: { text: `Missing required ${required.length > 1 ? 'fields' : 'field'}: ${required.join(', ')}. Call ${tool.name} again with ${required.length > 1 ? 'them' : 'it'}.`, isError: true } }
  }

  let presentation
  try {
    presentation = tool.present(input, env)
  } catch {
    presentation = { title: tool.name }
  }
  const fields = { kind: 'tool' as const, tool: tool.kind, name: tool.name, title: presentation.title, detail: presentation.detail, input, status: 'running' as const, parentId: env.parentId }
  // A preview shown while the arguments streamed becomes the real item, keeping its live diff.
  const preview = itemId ? session.item<ToolItem>(itemId) : undefined
  const item = preview
    ? session.update<ToolItem>(preview.id, { ...fields, meta: { ...preview.meta, ...presentation.meta } })!
    : session.add<ToolItem>({ id: itemId, ...fields, meta: presentation.meta })

  // A deferred end keeps its patch for finish(), except a denial, which shows at once.
  const end = (patch: Partial<ToolItem>, now = !defer): (() => void) | undefined => {
    const apply = (): void => { session.update<ToolItem>(item.id, { ...patch, endedAt: Date.now() }) }
    if (now) apply()
    else return apply
  }
  const fail = (message: string, status: 'error' | 'denied' = 'error'): ToolRun => {
    const finish = end({ status, error: message }, !defer || status === 'denied')
    return { itemId: item.id, result: { text: message, isError: true }, finish }
  }

  try {
    if (session.agentId !== 'main' && tool.kind === 'ask') return fail('Subagents cannot ask the user. Use Message to contact the parent agent.')
    const approval = tool.approval?.(input, env)
    if (approval) {
      const verdict = await gate(session, env.permissionMode, { ...approval, itemId: item.id, kind: tool.kind })
      if (!verdict.allowed) return fail(verdict.message, 'denied')
      if (env.signal.aborted) return fail('Stopped')
      session.update<ToolItem>(item.id, { status: 'running' })
    }

    const result = await tool.execute(input, {
      ...env,
      spawnSubagent: env.spawnSubagent ?? (session.team ? (request) => session.team!.spawn(request, session) : undefined),
      itemId: item.id,
      onOutput: (delta) => session.append(item.id, 'output', delta)
    })

    const current = session.item<ToolItem>(item.id)
    if (result.pending) return { itemId: item.id, result }
    // Very long results go to a temporary file the agent can Read in parts, as with terminal logs.
    // Only Glob and Grep are cut here; Bash cuts its own, and every other tool returns in full.
    if ((tool.kind === 'glob' || tool.kind === 'grep') && result.text.length > MAX_RESULT) {
      const dir = join(tmpdir(), 'galaxy-code')
      await mkdir(dir, { recursive: true })
      const file = join(dir, `output-${item.id}.txt`)
      await writeFile(file, result.text)
      result.text = `${result.text.slice(0, RESULT_PREVIEW)}\n…\n\n[Cut after ${RESULT_PREVIEW} of ${result.text.length} characters. The full output is saved to ${file}. This result is incomplete. Unless what you were looking for is already in the part above, your next step must be Read on that file, before you answer, summarize or call any other tool. Do not tell the user the output was cut or ask them to narrow it; read the file.]`
    }
    const finish = end({
      status: result.isError ? 'error' : 'done',
      output: result.display ?? result.text,
      error: result.isError ? oneLine(result.text.split('\n').pop() ?? '', 200) : undefined,
      meta: { ...(current?.meta ?? {}), ...(result.meta ?? {}) }
    })
    return { itemId: item.id, result, finish }
  } catch (err) {
    if (isAbortError(err) || env.signal.aborted) return fail('Stopped')
    const message = err instanceof ToolInputError ? `Invalid input: ${err.message}` : errorMessage(err)
    return fail(message)
  }
}

export function kindOf(tools: ToolDef[], name: string): ToolKind {
  return tools.find((t) => t.name === name)?.kind ?? 'other'
}

export type { ToolDef, ToolResult, ToolContext }
