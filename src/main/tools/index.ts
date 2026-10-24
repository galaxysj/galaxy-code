import type { ToolItem, ToolKind } from '@shared/types'
import { gate } from '../agent/approval'
import { mcp, type McpTool } from '../services/mcp'
import type { ChatToolSpec } from '../services/openrouter'
import { errorMessage, isAbortError, oneLine } from '../util'
import { createTool, editTool, globTool, grepTool, listTool, readTool } from './fs'
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
import { bashTool } from './shell'
import { terminalTool } from './terminal'
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

const EXPLORE_TOOLS: ToolDef[] = [readTool, grepTool, globTool, listTool, webSearchTool, webFetchTool]

/** Every built-in tool, in the order the model sees them. */
export const ALL_TOOLS: ToolDef[] = [
  ...EXPLORE_TOOLS,
  bashTool,
  terminalTool,
  editTool,
  createTool,
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
export const BRIDGE_TOOLS: ToolDef[] = [agentTool, messageTool, editTool, terminalTool, browserTool, listTabsTool, askTool, taskTool, presentTool, openTool, memoryTool, imageGenerationTool]

export function toolsForSubagent(_type: string): ToolDef[] {
  return ALL_TOOLS.filter((tool) => tool.kind !== 'ask')
}

function mcpAsTool(tool: McpTool): ToolDef {
  return {
    name: tool.qualified,
    kind: 'mcp',
    description: tool.description || `${tool.name} from the ${tool.server} MCP server.`,
    parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    present(input) {
      const preview = oneLine(JSON.stringify(input), 120)
      return { title: `${tool.server}: ${tool.name}`, detail: preview === '{}' ? undefined : preview, meta: { server: tool.server } }
    },
    approval(input) {
      if (tool.readOnly) return null
      return {
        action: { tool: `MCP ${tool.server}/${tool.name}`, description: tool.description.slice(0, 400), arguments: input },
        sessionKey: `mcp:${tool.qualified}`,
        sessionLabel: `Always allow ${tool.name} in this chat`
      }
    },
    async execute(input, ctx) {
      const result = await mcp.call(tool, input, ctx.signal)
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
  itemId?: string
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

  let presentation
  try {
    presentation = tool.present(input, env)
  } catch {
    presentation = { title: tool.name }
  }
  const item = session.add<ToolItem>({
    id: itemId,
    kind: 'tool',
    tool: tool.kind,
    name: tool.name,
    title: presentation.title,
    detail: presentation.detail,
    input,
    status: 'running',
    meta: presentation.meta,
    parentId: env.parentId
  })

  const fail = (message: string, status: 'error' | 'denied' = 'error'): ToolRun => {
    session.update<ToolItem>(item.id, { status, error: message, endedAt: Date.now() })
    return { itemId: item.id, result: { text: message, isError: true } }
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
    session.update<ToolItem>(item.id, {
      status: result.isError ? 'error' : 'done',
      output: result.display ?? result.text,
      error: result.isError ? oneLine(result.text.split('\n').pop() ?? '', 200) : undefined,
      meta: { ...(current?.meta ?? {}), ...(result.meta ?? {}) },
      endedAt: Date.now()
    })
    return { itemId: item.id, result }
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
