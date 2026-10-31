import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { query, type CanUseTool, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AskQuestion, FileDiff, SkillInfo, TaskEntry, ToolItem, ToolKind, ToolMeta } from '@shared/types'
import { commandPrefix, gate, outsideReadApproval } from '../agent/approval'
import { buildBridgeInstructions, gatherContext } from '../agent/prompt'
import { TurnWriter, type Session, type Turn } from '../agent/session'
import { bridge, BRIDGE_SERVER_NAME } from '../services/bridge'
import { skillNameForPath } from '../services/skills'
import { store } from '../store'
import { BRIDGE_TOOLS, messageTool, type ToolEnv } from '../tools'
import { bashTool } from '../tools/shell'
import { makeDiff } from '../tools/diff'
import { displayPath, errorMessage, isImagePath, oneLine, resolvePath, truncateEnd, which } from '../util'

type Input = Record<string, unknown>

const EDIT_FIELDS = ['file_path', 'path', 'old_string', 'new_string', 'content', 'patch']

/** Decode complete strings and the unfinished final string in a streamed tool input, for the given string fields. */
export function streamedEditInput(json: string, keys: readonly string[] = EDIT_FIELDS): Input {
  try { return JSON.parse(json) as Input } catch { /* The tool input is still arriving. */ }
  const input: Input = {}
  const fields = new RegExp(`"(${keys.join('|')})"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`, 'g')
  for (const match of json.matchAll(fields)) {
    let value = match[2]
    // Only trim an incomplete escape; preserve complete literal backslashes.
    for (let trimmed = 0; trimmed <= 6; trimmed++) {
      try {
        input[match[1]] = JSON.parse(`"${value}"`)
        break
      } catch { value = value.slice(0, -1) }
    }
  }
  return input
}

interface Presented {
  kind: ToolKind
  title: string
  detail?: string
  meta?: ToolMeta
}

const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'NotebookRead', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'BashOutput', 'ExitPlanMode', 'EnterPlanMode', 'Skill', 'Task', 'Agent', 'ToolSearch', 'ListMcpResources', 'ReadMcpResource'])

/** Read-only tools that still ask when they reach outside the working directory. */
const OUTSIDE_READ = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'])

/** Maps a Claude Code tool call onto Galaxy Code's tool vocabulary. */
function presentTool(name: string, input: Input, cwd: string, skills: SkillInfo[]): Presented {
  const s = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '')
  const file = s('file_path') || s('path') || s('notebook_path')
  const abs = file ? resolvePath(cwd, file) : ''

  switch (name) {
    case 'Read': {
      const skill = abs ? skillNameForPath(abs, skills) : null
      if (skill) return { kind: 'read', title: `Read ${skill} skill`, meta: { skill } }
      return { kind: 'read', title: `Read ${basename(abs)}`, detail: displayPath(cwd, abs) }
    }
    case 'Skill': {
      const id = s('skill') || s('command')
      const name = skills.find((skill) => skill.name === id)?.displayName ?? id
      return { kind: 'read', title: `Read ${name || 'a'} skill`, meta: { skill: id } }
    }
    case 'Grep':
      return {
        kind: 'grep',
        title: `Grep ${JSON.stringify(s('pattern'))}${s('path') ? ` in ${displayPath(cwd, s('path'))}` : s('glob') ? ` in ${s('glob')}` : ''}`,
        meta: { query: s('pattern') }
      }
    case 'Glob':
      return { kind: 'glob', title: `Glob ${s('pattern')}`, meta: { query: s('pattern') } }
    case 'LS':
      return { kind: 'list', title: `List ${displayPath(cwd, abs || cwd)}` }
    case 'WebSearch':
      return { kind: 'websearch', title: `Searched ${JSON.stringify(s('query'))}`, meta: { query: s('query') } }
    case 'WebFetch':
      return { kind: 'webfetch', title: `Fetched ${oneLine(s('url').replace(/^https?:\/\/(www\.)?/, ''), 70)}`, meta: { url: s('url') } }
    case 'Bash':
      return {
        kind: 'bash',
        title: s('description') || oneLine(s('command'), 80),
        detail: s('command'),
        meta: { command: s('command'), cwd, background: input.run_in_background === true }
      }
    case 'BashOutput':
      return { kind: 'bash', title: 'Checked background output' }
    case 'KillShell':
    case 'KillBash':
      return { kind: 'bash', title: 'Stopped a background command' }
    case 'Edit':
      return {
        kind: 'edit',
        title: `Edit ${basename(abs)}`,
        detail: displayPath(cwd, abs),
        meta: { diffs: [makeDiff(abs, s('old_string'), s('new_string'))] }
      }
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? (input.edits as Input[]) : []
      const diffs = edits.map((e) => makeDiff(abs, String(e.old_string ?? ''), String(e.new_string ?? '')))
      const merged: FileDiff = {
        path: abs,
        added: diffs.reduce((n, d) => n + d.added, 0),
        removed: diffs.reduce((n, d) => n + d.removed, 0),
        patch: diffs.map((d) => d.patch).join('\n')
      }
      return { kind: 'edit', title: `Edit ${basename(abs)}`, detail: displayPath(cwd, abs), meta: { diffs: [merged] } }
    }
    case 'NotebookEdit':
      return { kind: 'edit', title: `Edit ${basename(abs)}`, detail: displayPath(cwd, abs) }
    case 'Write':
      return {
        kind: 'create',
        title: `Create ${basename(abs)}`,
        detail: displayPath(cwd, abs),
        meta: { diffs: [makeDiff(abs, null, s('content'))] }
      }
    case 'Task':
    case 'Agent':
      return {
        kind: 'agent',
        title: oneLine(s('description') || 'Subagent', 80),
        detail: s('prompt'),
        meta: { agentType: s('subagent_type') || 'general' }
      }
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? (input.todos as Input[]) : []
      const tasks: TaskEntry[] = todos.map((t) => ({
        content: String(t.content ?? ''),
        status: t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending'
      }))
      const done = tasks.filter((t) => t.status === 'completed').length
      return { kind: 'task', title: done === 0 ? `Planned ${tasks.length} tasks` : `Updated tasks (${done}/${tasks.length} done)`, meta: { tasks } }
    }
    case 'TaskCreate':
      return { kind: 'task', title: `Added task: ${oneLine(s('subject'), 70)}` }
    case 'TaskUpdate':
      return { kind: 'task', title: 'Updated tasks' }
    case 'AskUserQuestion': {
      const questions = Array.isArray(input.questions) ? (input.questions as AskQuestion[]) : []
      return { kind: 'ask', title: oneLine(questions[0]?.question ?? 'Question', 90), meta: { questions } }
    }
    case 'ExitPlanMode':
      return { kind: 'other', title: 'Proposed a plan', detail: s('plan') }
    default: {
      const mcp = name.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/)
      if (mcp) {
        const preview = oneLine(JSON.stringify(input), 120)
        return { kind: 'mcp', title: `${mcp[1]}: ${mcp[2]}`, detail: preview === '{}' ? undefined : preview, meta: { server: mcp[1] } }
      }
      return { kind: 'other', title: name, detail: oneLine(JSON.stringify(input), 160) }
    }
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: { type?: string; text?: string }) => (block.type === 'text' ? (block.text ?? '') : block.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n')
}

/** Claude Code reports the real patch for file edits; prefer it over the preview built from the request. */
function diffFromStructured(path: string, result: unknown): FileDiff | null {
  const patch = (result as { structuredPatch?: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[] } | null)
    ?.structuredPatch
  if (!Array.isArray(patch) || patch.length === 0) return null
  let added = 0
  let removed = 0
  const lines: string[] = []
  for (const hunk of patch) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
      lines.push(line)
    }
  }
  return { path, added, removed, patch: lines.join('\n') }
}

function approvalFor(name: string, input: Input, kind: ToolKind): { sessionKey?: string; sessionLabel?: string } {
  if (kind === 'bash') {
    const prefix = commandPrefix(String(input.command ?? ''))
    return prefix ? { sessionKey: `bash:${prefix}`, sessionLabel: `Always allow \`${prefix}\` in this chat` } : {}
  }
  if (kind === 'edit' || kind === 'create') return { sessionKey: 'edit', sessionLabel: 'Allow all edits in this chat' }
  return { sessionKey: `tool:${name}`, sessionLabel: `Always allow ${name} in this chat` }
}

async function promptContent(turn: Turn): Promise<SDKUserMessage['message']['content']> {
  const blocks: unknown[] = []
  const others: string[] = []
  for (const attachment of turn.attachments) {
    if (isImagePath(attachment.path) && attachment.mime !== 'image/svg+xml') {
      const data = await readFile(attachment.path).catch(() => null)
      if (data) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: attachment.mime, data: data.toString('base64') } })
        continue
      }
    }
    others.push(attachment.path)
  }
  const note = others.length ? `\n\nAttached files:\n${others.map((p) => `- ${p}`).join('\n')}` : ''
  blocks.unshift({ type: 'text', text: (turn.text || 'See the attached files.') + note })
  return blocks as SDKUserMessage['message']['content']
}

function userMcpServers(): NonNullable<Options['mcpServers']> {
  const servers: NonNullable<Options['mcpServers']> = {}
  for (const config of store.settings.mcpServers) {
    if (!config.enabled) continue
    const name = config.name.replace(/[^A-Za-z0-9_-]/g, '_') || 'server'
    if (config.transport === 'stdio' && config.command) {
      servers[name] = { type: 'stdio', command: config.command, args: config.args ?? [], env: config.env ?? {} }
    } else if (config.transport === 'http' && config.url) {
      servers[name] = { type: 'http', url: config.url, headers: config.headers ?? {} }
    }
  }
  return servers
}

/** Runs a turn through the user's Claude Code login using the Claude Agent SDK. */
export async function runClaude(session: Session, turn: Turn): Promise<void> {
  const ctx = await gatherContext(session, { permissionMode: turn.permissionMode, modelName: turn.model.name, ultra: turn.ultra })
  const cwd = ctx.cwd

  // Claude Code has its own question and task tools, so those are not bridged. Shell commands are: Claude Code's own
  // Bash lives in the CLI, which exits when the turn ends and takes background processes with it, while Galaxy Code's
  // shells belong to the app and keep running.
  // An Explore subagent only reads and messages.
  const explore = session.agentId !== 'main' && session.subagentType === 'explore'
  const bridged = explore ? [messageTool] : [...BRIDGE_TOOLS, bashTool].filter((t) => t.name !== 'Ask' && t.name !== 'Task')
  const env: ToolEnv = { session, cwd, signal: turn.signal, permissionMode: turn.permissionMode, skills: ctx.skills }
  const handle = await bridge.register(bridged, env)

  const items = new Map<string, string>()
  const names = new Map<string, string>()
  const writers = new Map<string, TurnWriter>()
  const streamed = new Set<string>()
  const editStreams = new Map<string, { id: string; name: string; json: string; publishedAt: number }>()
  const taskList: (TaskEntry & { id: string })[] = []
  const pendingTaskSubjects = new Map<string, string>()

  const writerFor = (parentToolUseId: string | null): TurnWriter => {
    const key = parentToolUseId ?? ''
    let writer = writers.get(key)
    if (!writer) {
      writer = new TurnWriter(session, parentToolUseId ? items.get(parentToolUseId) : undefined)
      writers.set(key, writer)
    }
    return writer
  }

  const isBridgeTool = (name: string): boolean => name.startsWith(`mcp__${BRIDGE_SERVER_NAME}__`)
  // Housekeeping calls that say nothing about the work.
  const isHidden = (name: string): boolean => name === 'ToolSearch' || name === 'ListMcpResources'

  const ensureItem = (toolUseId: string, name: string, input: Input, parentToolUseId: string | null): string | null => {
    if (isBridgeTool(name) || isHidden(name)) return null
    names.set(toolUseId, name)
    const presented = presentTool(name, input, cwd, ctx.skills)
    const existing = items.get(toolUseId)
    if (existing) {
      const current = session.item<ToolItem>(existing)
      session.update<ToolItem>(existing, {
        tool: presented.kind,
        title: presented.title,
        detail: presented.detail,
        input,
        meta: { ...(current?.meta ?? {}), ...(presented.meta ?? {}) }
      })
      return existing
    }
    writerFor(parentToolUseId).end()
    const item = session.add<ToolItem>({
      kind: 'tool',
      tool: presented.kind,
      name,
      title: presented.title,
      detail: presented.detail,
      input,
      status: 'running',
      meta: presented.meta,
      parentId: parentToolUseId ? items.get(parentToolUseId) : undefined
    })
    items.set(toolUseId, item.id)
    return item.id
  }

  const canUseTool: CanUseTool = async (toolName, input, options) => {
    if (isBridgeTool(toolName)) return { behavior: 'allow', updatedInput: input }
    const itemId = ensureItem(options.toolUseID, toolName, input, null)
    if (!itemId) return { behavior: 'allow', updatedInput: input }

    if (toolName === 'AskUserQuestion') {
      const questions = Array.isArray(input.questions) ? (input.questions as AskQuestion[]) : []
      const answers = await session.ask(itemId, questions)
      if (!answers) return { behavior: 'deny', message: 'The user dismissed the question without answering.' }
      const current = session.item<ToolItem>(itemId)
      session.update<ToolItem>(itemId, { status: 'running', meta: { ...(current?.meta ?? {}), answers } })
      return { behavior: 'allow', updatedInput: { ...input, answers } }
    }

    const outside = OUTSIDE_READ.has(toolName) ? outsideReadApproval(cwd, input.file_path ?? input.path ?? input.notebook_path, toolName, input) : null
    if (outside) {
      const verdict = await gate(session, turn.permissionMode, { itemId, kind: session.item<ToolItem>(itemId)?.tool ?? 'read', ...outside })
      if (!verdict.allowed) return { behavior: 'deny', message: verdict.message }
      session.update<ToolItem>(itemId, { status: 'running' })
      return { behavior: 'allow', updatedInput: input }
    }
    if (READ_ONLY.has(toolName)) return { behavior: 'allow', updatedInput: input }

    const kind = session.item<ToolItem>(itemId)?.tool ?? 'other'
    const verdict = await gate(session, turn.permissionMode, {
      itemId,
      kind,
      action: { tool: toolName, working_directory: cwd, ...input, ...(options.decisionReason ? { flagged_because: options.decisionReason } : {}) },
      ...approvalFor(toolName, input, kind)
    })
    if (verdict.allowed) {
      session.update<ToolItem>(itemId, { status: 'running' })
      return { behavior: 'allow', updatedInput: input }
    }
    return { behavior: 'deny', message: verdict.message }
  }

  const account = store.settings.accounts.claude
  const executable = account.binaryPath.trim() ? await which(account.binaryPath.trim()) : await which('claude')
  const effort = turn.effort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(turn.effort) ? (turn.effort as Options['effort']) : undefined
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  turn.signal.addEventListener('abort', onAbort, { once: true })

  const stderr: string[] = []
  const options: Options = {
    cwd,
    model: turn.model.id,
    abortController: controller,
    includePartialMessages: true,
    permissionMode: session.agentId === 'main' ? 'default' : 'bypassPermissions',
    allowDangerouslySkipPermissions: session.agentId !== 'main',
    disallowedTools: ['Agent', 'Task', 'Edit', 'MultiEdit', 'Bash', 'BashOutput', 'KillShell', 'KillBash', ...(explore ? ['Write', 'NotebookEdit', 'Skill', 'TodoWrite'] : []), ...(session.agentId !== 'main' ? ['AskUserQuestion'] : [])],
    canUseTool,
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: buildBridgeInstructions(ctx, bridged.map((t) => t.name), turn.mentions) },
    mcpServers: { ...userMcpServers(), [BRIDGE_SERVER_NAME]: { type: 'http', url: handle.url, timeout: 60 * 60 * 1000 } },
    env: { ...(process.env as Record<string, string>), CLAUDE_AGENT_SDK_CLIENT_APP: 'galaxy-code/0.1.0' },
    stderr: (data) => {
      stderr.push(data)
      if (stderr.length > 40) stderr.shift()
    },
    ...(effort ? { effort } : {}),
    ...(turn.fast && turn.model.fastMode ? { settings: { fastMode: true } } : {}),
    ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    ...(session.doc.engine.claudeSessionId ? { resume: session.doc.engine.claudeSessionId, ...(session.doc.engine.forkClaude ? { forkSession: true } : {}) } : {})
  }

  let finished: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    finished = resolve
  })
  const content = await promptContent(turn)
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null } as SDKUserMessage
    // Keep the input stream open so permission answers can flow until the turn ends.
    await done
  }

  let failure: string | null = null
  let lastContext = 0

  const handleMessage = (message: SDKMessage): void => {
    switch (message.type) {
      case 'system': {
        if (message.subtype === 'init' && message.session_id) {
          session.doc.engine.claudeSessionId = message.session_id
          delete session.doc.engine.forkClaude
          store.touchDoc(session.id)
        }
        break
      }
      case 'stream_event': {
        const event = message.event as { type: string; index?: number; content_block?: { type: string; id?: string; name?: string }; delta?: { type: string; text?: string; thinking?: string; partial_json?: string } }
        const key = message.parent_tool_use_id ?? ''
        const streamKey = `${key}:${event.index ?? 0}`
        const writer = writerFor(message.parent_tool_use_id)
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use' && event.content_block.id && event.content_block.name) {
          ensureItem(event.content_block.id, event.content_block.name, {}, message.parent_tool_use_id)
          if (event.content_block.name === 'Edit' || event.content_block.name === 'Write' || event.content_block.name === 'MultiEdit') {
            editStreams.set(streamKey, { id: event.content_block.id, name: event.content_block.name, json: '', publishedAt: 0 })
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta' && event.delta.text) {
            streamed.add(key)
            writer.text(event.delta.text)
          } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
            streamed.add(key)
            writer.reasoning(event.delta.thinking)
          } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
            const edit = editStreams.get(streamKey)
            if (edit) {
              edit.json += event.delta.partial_json
              if (Date.now() - edit.publishedAt >= 32) {
                const input = streamedEditInput(edit.json)
                if (edit.name !== 'MultiEdit' || Array.isArray(input.edits)) ensureItem(edit.id, edit.name, input, message.parent_tool_use_id)
                edit.publishedAt = Date.now()
              }
            }
          }
        } else if (event.type === 'content_block_stop') {
          const edit = editStreams.get(streamKey)
          if (edit) {
            ensureItem(edit.id, edit.name, streamedEditInput(edit.json), message.parent_tool_use_id)
            editStreams.delete(streamKey)
          }
          writer.end()
        }
        break
      }
      case 'assistant': {
        const key = message.parent_tool_use_id ?? ''
        const writer = writerFor(message.parent_tool_use_id)
        const wasStreamed = streamed.delete(key)
        if (message.error) {
          // The reply is the error's own text, such as a usage-credits notice; it belongs above the message box, not in the chat.
          const text = (message.message.content as { type: string; text?: string }[]).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('').trim()
          failure = text || `Claude Code reported an error: ${String(message.error).replace(/_/g, ' ')}`
          break
        }
        const usage = message.message.usage as { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined
        if (usage && !message.parent_tool_use_id) {
          lastContext = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
        }
        for (const block of message.message.content as { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: Input }[]) {
          if (block.type === 'text' && block.text && !wasStreamed) {
            writer.text(block.text)
            writer.end()
          } else if (block.type === 'thinking' && block.thinking && !wasStreamed) {
            writer.reasoning(block.thinking)
            writer.end()
          } else if (block.type === 'tool_use' && block.id && block.name) {
            ensureItem(block.id, block.name, block.input ?? {}, message.parent_tool_use_id)
            if (block.name === 'TaskCreate') pendingTaskSubjects.set(block.id, String(block.input?.subject ?? ''))
            if (block.name === 'TaskUpdate') {
              const entry = taskList.find((t) => t.id === String(block.input?.taskId ?? ''))
              const status = block.input?.status
              if (entry && status === 'deleted') taskList.splice(taskList.indexOf(entry), 1)
              else if (entry && (status === 'pending' || status === 'in_progress' || status === 'completed')) entry.status = status
              if (entry && typeof block.input?.subject === 'string') entry.content = block.input.subject
            }
          }
        }
        break
      }
      case 'user': {
        const blocks = message.message.content
        if (!Array.isArray(blocks)) break
        for (const block of blocks as { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) {
          if (block.type !== 'tool_result' || !block.tool_use_id) continue
          const itemId = items.get(block.tool_use_id)
          if (!itemId) continue
          const item = session.item<ToolItem>(itemId)
          if (!item) continue
          const name = names.get(block.tool_use_id) ?? ''
          const text = resultText(block.content)
          const meta: ToolMeta = { ...(item.meta ?? {}) }

          if ((item.tool === 'edit' || item.tool === 'create') && !block.is_error) {
            const path = item.meta?.diffs?.[0]?.path ?? ''
            const real = diffFromStructured(path, message.tool_use_result)
            if (real) meta.diffs = [{ ...real, created: item.tool === 'create' && (message.tool_use_result as { type?: string } | null)?.type === 'create' }]
          }
          if (name === 'TaskCreate' && !block.is_error) {
            const created = (message.tool_use_result as { task?: { id?: string; subject?: string } } | null)?.task
            taskList.push({
              id: String(created?.id ?? taskList.length + 1),
              content: created?.subject ?? pendingTaskSubjects.get(block.tool_use_id) ?? '',
              status: 'pending'
            })
          }
          if (name === 'TaskCreate' || name === 'TaskUpdate') meta.tasks = taskList.map(({ content, status }) => ({ content, status }))
          if (item.tool === 'bash') {
            const result = message.tool_use_result as { interrupted?: boolean } | null
            meta.exitCode = block.is_error ? 1 : 0
            if (result?.interrupted) meta.exitCode = null
          }

          const denied = item.status === 'denied'
          session.update<ToolItem>(itemId, {
            status: denied ? 'denied' : block.is_error ? 'error' : 'done',
            output: truncateEnd(text, 60000),
            error: block.is_error && !denied ? oneLine(text, 200) : item.error,
            meta,
            endedAt: Date.now()
          })
        }
        break
      }
      case 'result': {
        const usage = message.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined
        if (usage) {
          session.addUsage(
            (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
            usage.output_tokens ?? 0,
            0,
            lastContext || undefined
          )
        }
        if (message.subtype !== 'success') {
          const errors = (message as { errors?: string[] }).errors
          failure ??= errors?.length ? errors.join('\n') : `Claude Code stopped: ${message.subtype.replace(/_/g, ' ')}`
        } else if (message.is_error) {
          failure ??= message.result || 'Claude Code reported an error'
        }
        finished()
        break
      }
      default:
        break
    }
  }

  try {
    for await (const message of query({ prompt: prompt(), options })) {
      handleMessage(message)
      if (message.type === 'result') break
    }
  } catch (err) {
    if (!turn.signal.aborted) {
      const detail = stderr.join('').trim().split('\n').slice(-4).join('\n')
      throw new Error(`${errorMessage(err)}${detail ? `\n${detail}` : ''}`)
    }
  } finally {
    finished()
    turn.signal.removeEventListener('abort', onAbort)
    for (const writer of writers.values()) writer.end()
    handle.dispose()
  }
  if (failure && !turn.signal.aborted) throw new Error(failure)
}
