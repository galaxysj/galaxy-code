import { basename } from 'node:path'
import type { AskQuestion, FileDiff, TaskEntry, ToolItem, ToolKind, ToolMeta } from '@shared/types'
import { commandPrefix, gate } from '../agent/approval'
import { buildBridgeInstructions, gatherContext, inlineMentionsBlock } from '../agent/prompt'
import { TurnWriter, type Session, type Turn } from '../agent/session'
import { bridge, BRIDGE_SERVER_NAME, type BridgeHandle } from '../services/bridge'
import { store } from '../store'
import { BRIDGE_TOOLS, type ToolEnv } from '../tools'
import { diffFromUnified } from '../tools/diff'
import { displayPath, errorMessage, isImagePath, oneLine, truncateEnd, which } from '../util'
import { RpcProcess } from './jsonrpc'

type Json = Record<string, unknown>

interface Connection {
  rpc: RpcProcess
  handle: BridgeHandle
  cwd: string
  threadId: string | null
  idleTimer: NodeJS.Timeout | null
}

const connections = new Map<string, Connection>()
const IDLE_MS = 15 * 60 * 1000

function tomlString(value: string): string {
  return JSON.stringify(value)
}

/** Codex takes MCP servers as config overrides on the command line. */
function mcpFlags(bridgeUrl: string): string[] {
  const flags = [
    '-c',
    `mcp_servers.${BRIDGE_SERVER_NAME}.url=${tomlString(bridgeUrl)}`,
    '-c',
    `mcp_servers.${BRIDGE_SERVER_NAME}.tool_timeout_sec=3600`
  ]
  for (const config of store.settings.mcpServers) {
    if (!config.enabled) continue
    const name = config.name.replace(/[^A-Za-z0-9_-]/g, '_') || 'server'
    if (name === BRIDGE_SERVER_NAME) continue
    if (config.transport === 'stdio' && config.command) {
      flags.push('-c', `mcp_servers.${name}.command=${tomlString(config.command)}`)
      if (config.args?.length) flags.push('-c', `mcp_servers.${name}.args=[${config.args.map(tomlString).join(', ')}]`)
      const env = Object.entries(config.env ?? {})
      if (env.length) flags.push('-c', `mcp_servers.${name}.env={ ${env.map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`).join(', ')} }`)
    } else if (config.transport === 'http' && config.url) {
      flags.push('-c', `mcp_servers.${name}.url=${tomlString(config.url)}`)
    }
  }
  return flags
}

export async function codexBinary(): Promise<string | null> {
  const configured = store.settings.accounts.codex.binaryPath.trim()
  return which(configured || 'codex')
}

export async function startCodexProcess(extraArgs: string[] = [], cwd?: string): Promise<RpcProcess> {
  const binary = await codexBinary()
  if (!binary) throw new Error('Codex CLI was not found. Install it or set its path in Settings → Accounts.')
  const rpc = new RpcProcess({ command: binary, args: ['app-server', ...extraArgs], cwd })
  await rpc.request(
    'initialize',
    {
      clientInfo: { name: 'galaxy_code', title: 'Galaxy Code', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false }
    },
    30000
  )
  rpc.notify('initialized')
  return rpc
}

async function connect(session: Session, env: ToolEnv): Promise<Connection> {
  const existing = connections.get(session.id)
  if (existing?.rpc.alive && existing.cwd === env.cwd) {
    existing.handle.update(env)
    return existing
  }
  if (existing) disposeCodex(session.id)

  // Codex keeps its own plan, so the Task tool is not bridged.
  const handle = await bridge.register(
    BRIDGE_TOOLS.filter((t) => t.name !== 'Task'),
    env
  )
  try {
    const rpc = await startCodexProcess(mcpFlags(handle.url), env.cwd)
    const connection: Connection = { rpc, handle, cwd: env.cwd, threadId: null, idleTimer: null }
    connections.set(session.id, connection)
    rpc.onExit(() => {
      if (connections.get(session.id) === connection) {
        connections.delete(session.id)
        handle.dispose()
      }
    })
    return connection
  } catch (err) {
    handle.dispose()
    throw err
  }
}

export function disposeCodex(chatId: string): void {
  const connection = connections.get(chatId)
  if (!connection) return
  connections.delete(chatId)
  if (connection.idleTimer) clearTimeout(connection.idleTimer)
  connection.handle.dispose()
  connection.rpc.kill()
}

export function disposeAllCodex(): void {
  for (const id of [...connections.keys()]) disposeCodex(id)
}

function policies(mode: Turn['permissionMode']): { approvalPolicy: string; sandbox: string; sandboxPolicy: Json } {
  if (mode === 'full') return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
  // Ask and Auto both route every write and command through Galaxy Code's own gate.
  return { approvalPolicy: 'untrusted', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
}

/** Codex wraps commands as `/bin/zsh -lc '<command>'`; show what the user would have typed. */
function unwrapShell(command: string): string {
  const match = command.match(/^(?:\S*\/)?(?:zsh|bash|sh)\s+-l?c\s+([\s\S]+)$/)
  if (!match) return command
  const inner = match[1].trim()
  if (inner.length >= 2 && inner[0] === inner[inner.length - 1] && (inner[0] === "'" || inner[0] === '"')) {
    return inner[0] === "'" ? inner.slice(1, -1).replace(/'\\''/g, "'") : inner.slice(1, -1).replace(/\\(["\\$`])/g, '$1')
  }
  return inner
}

interface Presented {
  kind: ToolKind
  title: string
  detail?: string
  meta?: ToolMeta
}

function presentCommand(item: Json, cwd: string): Presented {
  const command = unwrapShell(String(item.command ?? ''))
  const actions = Array.isArray(item.commandActions) ? (item.commandActions as Json[]) : []
  const meta: ToolMeta = { command, cwd: String(item.cwd ?? cwd) }
  // Codex explores through the shell; show recognizable reads and searches as such.
  if (actions.length > 0 && actions.every((a) => a.type === 'read' || a.type === 'listFiles' || a.type === 'search')) {
    const first = actions[0]
    if (first.type === 'read') {
      const names = actions.map((a) => String(a.name ?? basename(String(a.path ?? ''))))
      return { kind: 'read', title: `Read ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}`, detail: command, meta }
    }
    if (first.type === 'search') {
      const where = first.path ? ` in ${displayPath(cwd, String(first.path))}` : ''
      return { kind: 'grep', title: `Grep ${JSON.stringify(String(first.query ?? ''))}${where}`, detail: command, meta: { ...meta, query: String(first.query ?? '') } }
    }
    return { kind: 'list', title: `List ${first.path ? displayPath(cwd, String(first.path)) : '.'}`, detail: command, meta }
  }
  return { kind: 'bash', title: oneLine(command, 80), detail: command, meta }
}

function fileDiffs(item: Json): FileDiff[] {
  const changes = Array.isArray(item.changes) ? (item.changes as Json[]) : []
  return changes.map((change) => {
    const kind = (change.kind as Json | undefined)?.type
    return diffFromUnified(String(change.path ?? ''), String(change.diff ?? ''), { created: kind === 'add', deleted: kind === 'delete' })
  })
}

function presentItem(item: Json, cwd: string): Presented | null {
  switch (item.type) {
    case 'commandExecution':
      return presentCommand(item, cwd)
    case 'fileChange': {
      const diffs = fileDiffs(item)
      const first = diffs[0]
      const allNew = diffs.length > 0 && diffs.every((d) => d.created)
      const label = diffs.length === 1 ? basename(first.path) : `${diffs.length} files`
      return {
        kind: allNew ? 'create' : 'edit',
        title: `${allNew ? 'Create' : 'Edit'} ${label}`,
        detail: diffs.length === 1 ? displayPath(cwd, first.path) : undefined,
        meta: { diffs }
      }
    }
    case 'mcpToolCall': {
      if (item.server === BRIDGE_SERVER_NAME) return null
      const preview = oneLine(JSON.stringify(item.arguments ?? {}), 120)
      return { kind: 'mcp', title: `${String(item.server)}: ${String(item.tool)}`, detail: preview === '{}' ? undefined : preview, meta: { server: String(item.server) } }
    }
    case 'webSearch': {
      const action = item.action as Json | null
      if (action?.type === 'open_page') return { kind: 'webfetch', title: `Fetched ${oneLine(String(action.url ?? '').replace(/^https?:\/\/(www\.)?/, ''), 70)}`, meta: { url: String(action.url ?? '') } }
      const query = String(item.query || (action?.query as string | undefined) || ((action?.queries as string[] | undefined) ?? [])[0] || '')
      return { kind: 'websearch', title: `Searched ${JSON.stringify(query)}`, meta: { query } }
    }
    case 'collabAgentToolCall': {
      if (item.tool !== 'spawnAgent') return null
      return { kind: 'agent', title: oneLine(String(item.prompt ?? 'Subagent').split('\n')[0], 80), detail: String(item.prompt ?? ''), meta: { agentType: 'general' } }
    }
    case 'imageView':
      return { kind: 'read', title: `Viewed ${basename(String(item.path ?? 'image'))}` }
    case 'imageGeneration':
      return { kind: 'image', title: 'Generated an image' }
    case 'dynamicToolCall':
      return { kind: 'other', title: String(item.tool ?? 'Tool') }
    default:
      return null
  }
}

function mcpResultText(item: Json): string {
  const error = item.error as Json | null
  if (error?.message) return String(error.message)
  const content = (item.result as Json | null)?.content
  if (!Array.isArray(content)) return ''
  return content.map((part: Json) => (part.type === 'text' ? String(part.text ?? '') : '')).filter(Boolean).join('\n')
}

/** Runs a turn through the user's Codex login by driving `codex app-server`. */
export async function runCodex(session: Session, turn: Turn): Promise<void> {
  const ctx = await gatherContext(session, { permissionMode: turn.permissionMode, modelName: turn.model.name, ultra: turn.ultra })
  const cwd = ctx.cwd
  const env: ToolEnv = { session, cwd, signal: turn.signal, permissionMode: turn.permissionMode, skills: ctx.skills }
  const connection = await connect(session, env)
  if (connection.idleTimer) clearTimeout(connection.idleTimer)
  const { rpc } = connection
  const policy = policies(turn.permissionMode)
  const instructions = buildBridgeInstructions(ctx, BRIDGE_TOOLS.filter((t) => t.name !== 'Task').map((t) => t.name))

  if (!connection.threadId) {
    const saved = session.doc.engine.codexThreadId
    const params = { cwd, model: turn.model.id, approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox, developerInstructions: instructions }
    let threadId: string | null = null
    if (saved) {
      try {
        const resumed = await rpc.request<{ thread: { id: string } }>('thread/resume', { threadId: saved, ...params }, 60000)
        threadId = resumed.thread.id
      } catch {
        session.notice('info', 'The earlier Codex thread could not be resumed, starting a new one.')
      }
    }
    if (!threadId) {
      const started = await rpc.request<{ thread: { id: string } }>('thread/start', params, 60000)
      threadId = started.thread.id
    }
    connection.threadId = threadId
    session.doc.engine.codexThreadId = threadId
    store.touchDoc(session.id)
  }
  const threadId = connection.threadId

  const writer = new TurnWriter(session)
  const items = new Map<string, string>()
  const streamedMessages = new Set<string>()
  let turnId: string | null = null
  let failure: string | null = null
  let planItemId: string | null = null
  let finish: (status: string) => void = () => {}
  const completed = new Promise<string>((resolve) => {
    finish = resolve
  })

  const upsert = (raw: Json, done: boolean): void => {
    const id = String(raw.id ?? '')
    const presented = presentItem(raw, cwd)
    if (!presented || !id) return
    const status = String(raw.status ?? '')
    const failed = status === 'failed' || raw.success === false || !!raw.error
    const declined = status === 'declined'
    const patch: Partial<ToolItem> = {
      tool: presented.kind,
      title: presented.title,
      detail: presented.detail
    }
    let output: string | undefined
    const meta: ToolMeta = { ...(presented.meta ?? {}) }
    if (raw.type === 'commandExecution') {
      if (typeof raw.aggregatedOutput === 'string') output = truncateEnd(raw.aggregatedOutput, 60000)
      if (done) meta.exitCode = typeof raw.exitCode === 'number' ? raw.exitCode : null
    } else if (raw.type === 'mcpToolCall' && done) {
      output = truncateEnd(mcpResultText(raw), 60000)
    }

    const existing = items.get(id)
    if (existing) {
      const current = session.item<ToolItem>(existing)
      const keepStatus = current?.status === 'denied' || current?.status === 'awaiting'
      session.update<ToolItem>(existing, {
        ...patch,
        meta: { ...(current?.meta ?? {}), ...meta },
        ...(output !== undefined && output !== '' ? { output } : {}),
        ...(done
          ? {
              status: declined || current?.status === 'denied' ? 'denied' : failed ? 'error' : 'done',
              error: failed && !declined ? oneLine(output || 'Failed', 200) : current?.error,
              endedAt: Date.now()
            }
          : keepStatus
            ? {}
            : { status: 'running' })
      })
      return
    }
    writer.end()
    const created = session.add<ToolItem>({
      kind: 'tool',
      tool: presented.kind,
      name: String(raw.type),
      title: presented.title,
      detail: presented.detail,
      input: raw.type === 'commandExecution' ? { command: raw.command } : raw.type === 'mcpToolCall' ? raw.arguments : {},
      status: done ? (declined ? 'denied' : failed ? 'error' : 'done') : 'running',
      output,
      meta,
      ...(done ? { endedAt: Date.now() } : {})
    })
    items.set(id, created.id)
  }

  const showPlan = (steps: Json[]): void => {
    const tasks: TaskEntry[] = steps.map((s) => ({
      content: String(s.step ?? ''),
      status: s.status === 'completed' ? 'completed' : s.status === 'inProgress' ? 'in_progress' : 'pending'
    }))
    const done = tasks.filter((t) => t.status === 'completed').length
    const title = done === 0 ? `Planned ${tasks.length} tasks` : `Updated tasks (${done}/${tasks.length} done)`
    writer.end()
    planItemId = session.add<ToolItem>({ kind: 'tool', tool: 'task', name: 'update_plan', title, input: {}, status: 'done', meta: { tasks }, endedAt: Date.now() }).id
  }

  rpc.onNotification = (method, rawParams) => {
    const params = (rawParams ?? {}) as Json
    if (params.threadId && params.threadId !== threadId) return
    switch (method) {
      case 'turn/started':
        turnId = String((params.turn as Json | undefined)?.id ?? turnId ?? '')
        break
      case 'item/started': {
        const item = params.item as Json
        if (item.type === 'reasoning' || item.type === 'agentMessage') writer.end()
        else upsert(item, false)
        break
      }
      case 'item/agentMessage/delta':
        streamedMessages.add(String(params.itemId))
        writer.text(String(params.delta ?? ''))
        break
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        writer.reasoning(String(params.delta ?? ''))
        break
      case 'item/reasoning/summaryPartAdded':
        writer.reasoning('\n\n')
        break
      case 'item/commandExecution/outputDelta': {
        const itemId = items.get(String(params.itemId))
        if (itemId) session.append(itemId, 'output', String(params.delta ?? ''))
        break
      }
      case 'item/completed': {
        const item = params.item as Json
        if (item.type === 'agentMessage') {
          if (!streamedMessages.has(String(item.id)) && item.text) writer.text(String(item.text))
          writer.end()
        } else if (item.type === 'reasoning') {
          writer.end()
        } else if (item.type === 'contextCompaction') {
          session.notice('info', 'Earlier conversation was summarized to free up context.')
        } else {
          upsert(item, true)
        }
        break
      }
      case 'turn/plan/updated':
        if (Array.isArray(params.plan)) showPlan(params.plan as Json[])
        break
      case 'thread/tokenUsage/updated': {
        const usage = params.tokenUsage as { last?: { inputTokens?: number; outputTokens?: number } } | undefined
        if (usage?.last) session.addUsage(usage.last.inputTokens ?? 0, usage.last.outputTokens ?? 0, 0, usage.last.inputTokens ?? 0)
        break
      }
      case 'error': {
        const error = params.error as Json | undefined
        if (!params.willRetry && error?.message) failure = String(error.message)
        break
      }
      case 'turn/completed': {
        const done = params.turn as Json
        if (done.status === 'failed') failure = String((done.error as Json | null)?.message ?? failure ?? 'Codex could not complete the turn')
        finish(String(done.status))
        break
      }
      default:
        break
    }
  }

  rpc.onRequest = async (method, rawParams) => {
    const params = (rawParams ?? {}) as Json
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval': {
        const isCommand = method === 'item/commandExecution/requestApproval'
        let itemId = items.get(String(params.itemId))
        if (!itemId) {
          // Approval can arrive before the item itself.
          upsert(isCommand ? { id: params.itemId, type: 'commandExecution', command: params.command, cwd: params.cwd, commandActions: params.commandActions } : { id: params.itemId, type: 'fileChange', changes: [] }, false)
          itemId = items.get(String(params.itemId))
        }
        if (!itemId) return { decision: 'decline' }
        const item = session.item<ToolItem>(itemId)
        const command = unwrapShell(String(params.command ?? item?.meta?.command ?? ''))
        const prefix = isCommand ? commandPrefix(command) : ''
        const verdict = await gate(session, turn.permissionMode, {
          itemId,
          // Read-style commands still need approval here, so present them as what they are.
          kind: isCommand ? 'bash' : 'edit',
          action: isCommand
            ? { tool: 'Bash', command, working_directory: String(params.cwd ?? cwd), reason: params.reason ?? null }
            : { tool: 'Edit', files: (item?.meta?.diffs ?? []).map((d) => ({ path: d.path, patch: d.patch.slice(0, 1500) })), reason: params.reason ?? null },
          sessionKey: isCommand ? (prefix ? `bash:${prefix}` : undefined) : 'edit',
          sessionLabel: isCommand ? (prefix ? `Always allow \`${prefix}\` in this chat` : undefined) : 'Allow all edits in this chat'
        })
        if (verdict.allowed) session.update<ToolItem>(itemId, { status: 'running' })
        return { decision: verdict.allowed ? 'accept' : 'decline' }
      }
      case 'execCommandApproval':
      case 'applyPatchApproval':
        return { decision: turn.permissionMode === 'full' ? 'approved' : { denied: { rejection: 'Not supported by this client' } } }
      case 'item/tool/requestUserInput': {
        if (session.agentId !== 'main') return { answers: {} }
        const asked = Array.isArray(params.questions) ? (params.questions as Json[]) : []
        const questions: AskQuestion[] = asked.map((q) => ({
          header: q.header ? String(q.header) : undefined,
          question: String(q.question ?? ''),
          options: Array.isArray(q.options) ? (q.options as Json[]).map((o) => ({ label: String(o.label ?? ''), description: o.description ? String(o.description) : undefined })) : []
        }))
        writer.end()
        const item = session.add<ToolItem>({ kind: 'tool', tool: 'ask', name: 'request_user_input', title: oneLine(questions[0]?.question ?? 'Question', 90), input: params, status: 'running', meta: { questions } })
        const answers = await session.ask(item.id, questions)
        session.update<ToolItem>(item.id, { status: answers ? 'done' : 'denied', meta: { questions, answers: answers ?? undefined }, endedAt: Date.now() })
        const out: Record<string, { answers: string[] }> = {}
        asked.forEach((q, i) => {
          const answer = answers?.[questions[i].question]
          out[String(q.id)] = { answers: answer ? [answer] : [] }
        })
        return { answers: out }
      }
      case 'mcpServer/elicitation/request': {
        // Tools on the bridge are gated inside Galaxy Code already.
        if (params.serverName === BRIDGE_SERVER_NAME || turn.permissionMode === 'full') return { action: 'accept', content: {}, _meta: null }
        return { action: 'decline', content: null, _meta: null }
      }
      case 'item/permissions/requestApproval':
        return { permissions: {}, scope: 'turn' }
      default:
        throw new Error(`Unsupported request: ${method}`)
    }
  }

  const input: Json[] = []
  const others: string[] = []
  for (const attachment of turn.attachments) {
    if (isImagePath(attachment.path)) input.push({ type: 'localImage', path: attachment.path })
    else others.push(attachment.path)
  }
  const note = others.length ? `\n\nAttached files:\n${others.map((p) => `- ${p}`).join('\n')}` : ''
  input.unshift({ type: 'text', text: `${inlineMentionsBlock(turn.mentions)}\n\n${turn.text || 'See the attached files.'}${note}`, text_elements: [] })

  const onExit = (reason: string): void => {
    failure ??= reason
    finish('failed')
  }
  rpc.onExit(onExit)
  const onAbort = (): void => {
    if (turnId) void rpc.request('turn/interrupt', { threadId, turnId }, 5000).catch(() => {})
    // If Codex does not acknowledge, do not leave the UI hanging.
    setTimeout(() => finish('interrupted'), 4000)
  }
  turn.signal.addEventListener('abort', onAbort, { once: true })

  try {
    const started = await rpc.request<{ turn: { id: string } }>('turn/start', {
      threadId,
      input,
      cwd,
      model: turn.model.id,
      approvalPolicy: policy.approvalPolicy,
      sandboxPolicy: policy.sandboxPolicy,
      ...(turn.effort ? { effort: turn.effort } : {}),
      serviceTier: turn.fast && turn.model.fastMode ? 'priority' : null
    })
    turnId = started.turn.id
    if (turn.signal.aborted) onAbort()
    await completed
  } catch (err) {
    if (!turn.signal.aborted) failure ??= errorMessage(err)
  } finally {
    turn.signal.removeEventListener('abort', onAbort)
    writer.end()
    void planItemId
    rpc.onNotification = () => {}
    if (connections.get(session.id) === connection) {
      connection.idleTimer = setTimeout(() => disposeCodex(session.id), IDLE_MS)
    }
  }
  if (failure && !turn.signal.aborted) throw new Error(failure)
}

/** One reply from the Codex account in a throwaway read-only thread, for utility text such as commit messages. */
export async function codexComplete(model: string, instructions: string, prompt: string, cwd: string, signal: AbortSignal): Promise<string> {
  const rpc = await startCodexProcess([], cwd)
  try {
    const started = await rpc.request<{ thread: { id: string } }>('thread/start', { cwd, model, approvalPolicy: 'never', sandbox: 'read-only', developerInstructions: instructions }, 60000)
    const threadId = started.thread.id
    let text = ''
    const reply = new Promise<string>((resolve, reject) => {
      rpc.onExit((reason) => reject(new Error(reason)))
      signal.addEventListener('abort', () => reject(new Error('Timed out waiting for Codex')), { once: true })
      rpc.onNotification = (method, rawParams) => {
        const params = (rawParams ?? {}) as Json
        if (params.threadId && params.threadId !== threadId) return
        if (method === 'item/completed') {
          const item = params.item as Json
          if (item.type === 'agentMessage' && item.text) text = String(item.text)
        } else if (method === 'turn/completed') {
          const done = params.turn as Json
          if (done.status === 'failed') reject(new Error(String((done.error as Json | null)?.message ?? 'Codex could not complete the turn')))
          else resolve(text)
        }
      }
    })
    await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }], cwd, model, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } })
    return await reply
  } finally {
    rpc.kill()
  }
}
