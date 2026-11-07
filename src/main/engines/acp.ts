import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { AcpAgents, type AcpAgentSpec } from '@shared/acp-registry'
import { ACCOUNT_LABELS, type AccountId, type AgentMode, type AcpConfigChoice, type AcpConfigOption, type FileDiff, type TaskEntry, type ToolItem, type ToolKind, type ToolMeta } from '@shared/types'
import { commandPrefix, gate } from '../agent/approval'
import { acpSystemPrompt, acpTurnContext, gatherContext, inlineMentionsBlock } from '../agent/prompt'
import { TurnWriter, type Session, type Turn } from '../agent/session'
import { bridge, BRIDGE_SERVER_NAME, bridgeStdioCommand, type BridgeHandle } from '../services/bridge'
import { installedRegistryLaunch, registryLaunch } from '../services/acpRegistry'
import { store } from '../store'
import { ALL_TOOLS, type ToolDef, type ToolEnv } from '../tools'
import { makeDiff } from '../tools/diff'
import { displayPath, errorMessage, isImagePath, oneLine, resolvePath, truncateEnd, which } from '../util'
import { RpcError, RpcProcess } from './jsonrpc'

type Json = Record<string, unknown>

/** Every Galaxy Code tool, lent to ACP agents, which pick between them and their own. */
const ACP_TOOLS: ToolDef[] = ALL_TOOLS

export function acpAgent(id: AccountId): AcpAgentSpec | null {
  return AcpAgents.find((agent) => agent.ID === id) ?? null
}

function requireAgent(id: AccountId): AcpAgentSpec {
  const agent = acpAgent(id)
  if (!agent) throw new Error(`${id} is not in the ACP registry`)
  return agent
}

/** The inherited environment minus what the registry entry unsets. */
export function acpBaseEnv(agent: AcpAgentSpec): NodeJS.ProcessEnv {
  const unset = (agent.UnsetEnv ?? []).map((pattern) => new RegExp(pattern, 'i'))
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !unset.some((pattern) => pattern.test(name))))
}

/** How a registry entry starts as an Agent Client Protocol server on stdio. */
function launchFor(agent: AcpAgentSpec, mode: Turn['permissionMode']): { args: string[]; env: NodeJS.ProcessEnv } {
  const full = mode === 'full'
  return {
    args: full && agent.FullAccessArgs ? agent.FullAccessArgs : agent.Args,
    env: { ...acpBaseEnv(agent), ...(full && agent.FullAccessEnv ? agent.FullAccessEnv : (agent.Env ?? {})) }
  }
}

/** True when the permission mode is fixed at launch, so changing it means a new process. */
function modeAtLaunch(agent: AcpAgentSpec): boolean {
  return !!(agent.FullAccessArgs || agent.FullAccessEnv)
}

export async function acpBinary(id: AccountId): Promise<string | null> {
  const configured = store.settings.accounts[id]?.binaryPath.trim()
  if (configured) return which(configured)
  const agent = acpAgent(id)
  for (const name of agent?.Binaries ?? []) {
    const found = await which(name)
    if (found) return found
  }
  if (agent?.Runner) return which(process.platform === 'win32' && agent.Runner.Command === 'npx' ? 'npx.cmd' : agent.Runner.Command)
  if (agent?.RegistryId) return (await installedRegistryLaunch(agent.RegistryId))?.command ?? null
  return null
}

/** The command that starts an agent's CLI: its own binary, or the registry's package runner with its pinned release. */
export async function acpCommand(id: AccountId): Promise<{ command: string; prefix: string[] } | null> {
  const command = await acpBinary(id)
  if (!command) return null
  const runner = acpAgent(id)?.Runner
  const viaRunner = !store.settings.accounts[id]?.binaryPath.trim() && runner && basename(command).replace(/\.cmd$/i, '') === runner.Command
  return { command, prefix: viaRunner ? runner.Args : [] }
}

export async function acpLaunch(id: AccountId, mode: Turn['permissionMode']): Promise<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> {
  const agent = requireAgent(id)
  const launch = launchFor(agent, mode)
  if (agent.RegistryId && !store.settings.accounts[id]?.binaryPath.trim()) {
    const release = await registryLaunch(agent.RegistryId)
    return { command: release.command, args: [...release.args, ...launch.args], env: { ...launch.env, ...release.env } }
  }
  const found = await acpCommand(id)
  if (!found) throw new Error(`${agent.DisplayName} CLI was not found. Install it${agent.Runner ? ` or ${agent.Runner.Command}` : ''}, or set its path in Settings → ACP agents.`)
  return { command: found.command, args: [...found.prefix, ...launch.args], env: launch.env }
}

// Session config options

/** Option ids that came from the older `models` / `modes` session fields, which have their own setters. */
const LEGACY_MODEL = 'model'
const LEGACY_MODE = 'mode'

/** Agents can list a choice in more than one group, such as Recent and its provider; it is offered once, where it first appears. */
function uniqueChoices(choices: AcpConfigChoice[]): AcpConfigChoice[] {
  const seen = new Set<string>()
  return choices.filter((choice) => !seen.has(choice.value) && !!seen.add(choice.value))
}

function choicesOf(raw: unknown): AcpConfigChoice[] {
  const out: AcpConfigChoice[] = []
  for (const entry of Array.isArray(raw) ? (raw as Json[]) : []) {
    if (Array.isArray(entry.options)) {
      const group = String(entry.name ?? entry.group ?? '')
      for (const choice of choicesOf(entry.options)) out.push({ ...choice, group })
    } else if (entry.value !== undefined) {
      out.push({ value: String(entry.value), name: String(entry.name ?? entry.value), ...(entry.description ? { description: String(entry.description) } : {}) })
    }
  }
  return out
}

/**
 * Reads the options an agent reports with a session: the standard
 * `configOptions`, or the older `models` and `modes` fields from agents that
 * predate them. The second value lists the ids that use the older setters.
 */
function optionsOf(result: Json): { options: AcpConfigOption[]; legacy: Set<string> } {
  const legacy = new Set<string>()
  if (Array.isArray(result.configOptions)) {
    const options = (result.configOptions as Json[])
      .filter((option) => option.type === undefined || option.type === 'select')
      .map((option) => ({
        id: String(option.id ?? ''),
        name: String(option.name ?? option.id ?? ''),
        ...(option.description ? { description: String(option.description) } : {}),
        category: typeof option.category === 'string' ? option.category : null,
        currentValue: String(option.currentValue ?? ''),
        options: uniqueChoices(choicesOf(option.options))
      }))
      .filter((option) => option.id && option.options.length > 0)
    return { options, legacy }
  }
  const options: AcpConfigOption[] = []
  const models = result.models as Json | undefined
  if (models && Array.isArray(models.availableModels) && models.availableModels.length > 0) {
    legacy.add(LEGACY_MODEL)
    options.push({
      id: LEGACY_MODEL,
      name: 'Model',
      category: 'model',
      currentValue: String(models.currentModelId ?? ''),
      options: uniqueChoices((models.availableModels as Json[]).map((m) => ({ value: String(m.modelId ?? ''), name: String(m.name ?? m.modelId ?? ''), ...(m.description ? { description: String(m.description) } : {}) })))
    })
  }
  const modes = result.modes as Json | undefined
  if (modes && Array.isArray(modes.availableModes) && modes.availableModes.length > 0) {
    legacy.add(LEGACY_MODE)
    options.push({
      id: LEGACY_MODE,
      name: 'Mode',
      category: 'mode',
      currentValue: String(modes.currentModeId ?? ''),
      options: (modes.availableModes as Json[]).map((m) => ({ value: String(m.id ?? ''), name: String(m.name ?? m.id ?? ''), ...(m.description ? { description: String(m.description) } : {}) }))
    })
  }
  return { options, legacy }
}

/** Moves the session onto the values the user picked, skipping any the agent no longer offers. */
async function applyConfig(connection: Connection, sessionId: string, wanted: Record<string, string>): Promise<void> {
  for (const [id, value] of Object.entries(wanted)) {
    const option = connection.options.find((o) => o.id === id)
    if (!option || option.currentValue === value || !option.options.some((c) => c.value === value)) continue
    if (connection.legacy.has(id)) {
      if (id === LEGACY_MODEL) await connection.rpc.request('session/set_model', { sessionId, modelId: value }, 15000)
      else await connection.rpc.request('session/set_mode', { sessionId, modeId: value }, 15000)
      option.currentValue = value
      continue
    }
    const result = await connection.rpc.request<Json>('session/set_config_option', { sessionId, configId: id, value }, 15000)
    // Changing one option can change others, so take the full list the agent sends back.
    if (Array.isArray(result?.configOptions)) connection.options = optionsOf(result).options
    else option.currentValue = value
  }
}

const probes = new Map<string, Promise<AcpConfigOption[]>>()

/**
 * Sign-in state an ACP agent has shown: false after it asked for sign-in, true after a sign-in through Galaxy Code.
 * Agents have no standard way to report it up front, so Settings shows what was last seen.
 */
export const acpSignedIn = new Map<AccountId, boolean>()

function isAuthError(err: unknown): boolean {
  return err instanceof RpcError && (err.code === -32000 || /auth/i.test(err.message))
}

/** An agent that asked for sign-in before it would open a session. */
class AcpSignInError extends Error {}

/** Records a sign-in request and turns it into a message that says where to sign in. */
function signInError(id: AccountId, err: unknown): unknown {
  if (!isAuthError(err)) return err
  acpSignedIn.set(id, false)
  return new AcpSignInError(`${ACCOUNT_LABELS[id]} is not signed in. Open Settings → ACP agents and sign in, then try again.`)
}

/**
 * probeAcpOptions for the renderer: a failure comes back as a value, so it never reaches the terminal as an
 * unhandled IPC error, and says when the agent only needs a sign-in.
 */
export async function acpOptionsResult(id: AccountId, cwd: string, fresh = false): Promise<{ options: AcpConfigOption[]; error?: string; signIn?: boolean }> {
  try {
    return { options: await probeAcpOptions(id, cwd, fresh) }
  } catch (err) {
    return { options: [], error: err instanceof Error ? err.message : String(err), ...(err instanceof AcpSignInError ? { signIn: true } : {}) }
  }
}

/**
 * The options an agent offers before any chat exists, read from a throwaway
 * session. Cached per agent until `fresh` is set.
 */
export function probeAcpOptions(id: AccountId, cwd: string, fresh = false): Promise<AcpConfigOption[]> {
  const cached = probes.get(id)
  if (cached && !fresh) return cached
  const probe = (async () => {
    const launch = await acpLaunch(id, 'ask')
    const rpc = new RpcProcess({ ...launch, cwd, strict: true })
    try {
      await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'galaxy-code', title: 'Galaxy Code', version: '0.1.0' } }, id === 'antigravity' ? 180000 : 30000)
      const opened = await rpc.request<Json>('session/new', { cwd, mcpServers: [] }, 60000)
      acpSignedIn.set(id, true)
      return optionsOf(opened).options
    } catch (err) {
      throw signInError(id, err)
    } finally {
      rpc.kill()
    }
  })()
  probes.set(id, probe)
  probe.catch(() => {
    if (probes.get(id) === probe) probes.delete(id)
  })
  return probe
}

interface Connection {
  account: AccountId
  rpc: RpcProcess
  handle: BridgeHandle
  cwd: string
  mode: Turn['permissionMode']
  sessionId: string | null
  options: AcpConfigOption[]
  legacy: Set<string>
  capabilities: Json
  /** True while a resumed session replays its history at us. */
  replaying: boolean
  idleTimer: NodeJS.Timeout | null
}

const connections = new Map<string, Connection>()
const IDLE_MS = 15 * 60 * 1000

export function disposeAcp(chatId: string): void {
  const connection = connections.get(chatId)
  if (!connection) return
  connections.delete(chatId)
  if (connection.idleTimer) clearTimeout(connection.idleTimer)
  connection.handle.dispose()
  connection.rpc.kill()
}

export function disposeAllAcp(): void {
  for (const id of [...connections.keys()]) disposeAcp(id)
}

function mcpServerList(bridgeUrl: string, capabilities: Json): Json[] {
  const mcpCaps = (capabilities.mcpCapabilities ?? {}) as Json
  const servers: Json[] = []
  if (mcpCaps.http) servers.push({ type: 'http', name: BRIDGE_SERVER_NAME, url: bridgeUrl, headers: [] })
  else {
    // Every ACP agent takes stdio servers; those without HTTP reach the bridge through a relay.
    const relay = bridgeStdioCommand(bridgeUrl)
    servers.push({ name: BRIDGE_SERVER_NAME, command: relay.command, args: relay.args, env: Object.entries(relay.env).map(([name, value]) => ({ name, value })) })
  }
  for (const config of store.settings.mcpServers) {
    if (!config.enabled) continue
    if (config.transport === 'stdio' && config.command) {
      servers.push({
        name: config.name,
        command: config.command,
        args: config.args ?? [],
        env: Object.entries(config.env ?? {}).map(([name, value]) => ({ name, value }))
      })
    } else if (config.transport === 'http' && config.url && mcpCaps.http) {
      servers.push({
        type: 'http',
        name: config.name,
        url: config.url,
        headers: Object.entries(config.headers ?? {}).map(([name, value]) => ({ name, value }))
      })
    }
  }
  return servers
}

async function connect(account: AccountId, session: Session, env: ToolEnv, mode: Turn['permissionMode']): Promise<Connection> {
  const agent = requireAgent(account)
  const existing = connections.get(session.id)
  const modeChanged = modeAtLaunch(agent) && existing && (existing.mode === 'full') !== (mode === 'full')
  if (existing?.rpc.alive && existing.account === account && existing.cwd === env.cwd && !modeChanged) {
    existing.handle.update(env)
    return existing
  }
  if (existing) disposeAcp(session.id)

  const label = ACCOUNT_LABELS[account]
  const launch = await acpLaunch(account, mode)
  const handle = await bridge.register(ACP_TOOLS, env)
  const rpc = new RpcProcess({
    command: launch.command,
    args: launch.args,
    cwd: env.cwd,
    env: launch.env,
    strict: true
  })
  try {
    const init = await rpc.request<Json>(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        clientInfo: { name: 'galaxy-code', title: 'Galaxy Code', version: '0.1.0' }
      },
      account === 'antigravity' ? 180000 : 30000
    )
    const connection: Connection = {
      account,
      rpc,
      handle,
      cwd: env.cwd,
      mode,
      sessionId: null,
      options: [],
      legacy: new Set(),
      capabilities: (init.agentCapabilities ?? {}) as Json,
      replaying: false,
      idleTimer: null
    }
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
    rpc.kill()
    throw new Error(`Could not start ${label}: ${errorMessage(err)}`)
  }
}

const KIND_MAP: Record<string, ToolKind> = {
  read: 'read',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
  search: 'grep',
  execute: 'bash',
  fetch: 'webfetch',
  think: 'other',
  switch_mode: 'other',
  other: 'other'
}

const KIND_VERB: Record<string, string> = { read: 'Read', edit: 'Edit', delete: 'Delete', move: 'Move', search: 'Search', fetch: 'Fetch' }

/** Some agents title a call with just the path; give it the verb the kind implies. */
function titleFor(kindName: string, rawTitle: string, path: string): string {
  const title = rawTitle.trim()
  const verb = KIND_VERB[kindName]
  if (!title) return path ? `${verb ?? kindName} ${basename(path)}` : (verb ?? kindName)
  if (verb && !/\s/.test(title)) return `${verb} ${title.includes('/') ? basename(title) : title}`
  return title
}

const BRIDGE_TOOL_NAMES = ACP_TOOLS.map((t) => t.name).join('|')
const BRIDGE_TITLE = new RegExp(`^(?:mcp__)?${BRIDGE_SERVER_NAME}(?:__|[_.:/ ])(?:${BRIDGE_TOOL_NAMES})$`, 'i')

/**
 * True for calls to Galaxy Code's own bridge tools, which draw their own
 * timeline items. Matches the tool name exactly: titles are often file paths,
 * and a loose match would wave real edits through without approval.
 */
function isBridgeCall(update: Json): boolean {
  return BRIDGE_TITLE.test(String(update.title ?? '').trim())
}

/** A call's input in a fixed key order, to match an agent's report of a call with the bridge's; empty for no input. */
function inputKey(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length === 0) return ''
  const sorted = (value: unknown): unknown => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value as Json).sort().map((key) => [key, sorted((value as Json)[key])]))
    : value
  return JSON.stringify(sorted(input))
}

function contentOf(update: Json, cwd: string): { output?: string; diffs?: FileDiff[] } {
  const content = Array.isArray(update.content) ? (update.content as Json[]) : []
  const texts: string[] = []
  const diffs: FileDiff[] = []
  for (const block of content) {
    if (block.type === 'diff') {
      const oldText = typeof block.oldText === 'string' ? block.oldText : null
      diffs.push(makeDiff(resolvePath(cwd, String(block.path ?? '')), oldText, String(block.newText ?? '')))
    } else if (block.type === 'content') {
      const inner = block.content as Json | undefined
      if (inner?.type === 'text' && inner.text) texts.push(String(inner.text))
    }
  }
  const rawOutput = update.rawOutput
  if (texts.length === 0 && rawOutput !== undefined && rawOutput !== null) {
    const out = rawOutput as Json
    texts.push(typeof rawOutput === 'string' ? rawOutput : String(out.output ?? out.stdout ?? out.content ?? '') || '')
  }
  return {
    output: texts.length ? truncateEnd(texts.join('\n'), 60000) : undefined,
    diffs: diffs.length ? diffs : undefined
  }
}

const MODE_PATTERNS: Record<'ask' | 'plan', RegExp> = {
  plan: /plan/i,
  ask: /\b(ask|chat|read[\s_-]?only|question)/i
}

/** For agents with no Ask or Plan mode of their own. */
const MODE_NOTES: Record<AgentMode, string> = {
  multitask: '<mode>Multitask: split this request into independent tasks and give each to its own subagent with the galaxy Agent tool, all in one turn so they run in parallel. Then collect their reports with the galaxy Message tool (action wait) and answer from them.</mode>',
  ask: '<mode>Ask: answer with read-only actions. Do not create, edit or delete files, and do not run commands that change anything.</mode>',
  plan: '<mode>Plan: research and write a plan for this request before building it. Do not change project files; give the plan in your reply.</mode>'
}

/** The agent's own session mode that matches Galaxy Code's Ask or Plan, if it has one. */
function agentModeFor(options: AcpConfigOption[], mode: 'ask' | 'plan'): { option: string; value: string } | null {
  const option = options.find((entry) => entry.category === 'mode' || entry.id === LEGACY_MODE)
  const choice = option?.options.find((entry) => MODE_PATTERNS[mode].test(entry.value) || MODE_PATTERNS[mode].test(entry.name))
  return option && choice ? { option: option.id, value: choice.value } : null
}

/** Runs a turn through a CLI that speaks the Agent Client Protocol. */
export async function runAcp(account: AccountId, session: Session, turn: Turn): Promise<void> {
  const label = ACCOUNT_LABELS[account]
  const ctx = await gatherContext(session, { permissionMode: turn.permissionMode, modelName: turn.model.name, ultra: turn.ultra })
  const cwd = ctx.cwd
  const env: ToolEnv = { session, cwd, signal: turn.signal, permissionMode: turn.permissionMode, skills: ctx.skills }
  const connection = await connect(account, session, env, turn.permissionMode)
  if (connection.idleTimer) clearTimeout(connection.idleTimer)
  const { rpc } = connection

  const writer = new TurnWriter(session)
  const items = new Map<string, string>()
  const skipped = new Set<string>()

  // Agents also report their calls to Galaxy Code's bridge tools, often titled only by the tool name. The bridge draws
  // its own item, so the agent's item with the same input is dropped, whichever of the two arrives first.
  const bridgeInputs = new Map<string, number>()
  const dropAgentItem = (callId: string): void => {
    const itemId = items.get(callId)
    items.delete(callId)
    skipped.add(callId)
    if (itemId) session.replaceItems(session.doc.items.filter((item) => item.id !== itemId))
  }
  const fromBridge = (input: unknown): boolean => {
    const key = inputKey(input)
    const at = key ? bridgeInputs.get(key) : undefined
    return at !== undefined && Date.now() - at < 120000
  }
  connection.handle.onCall((_name, input) => {
    const key = inputKey(input)
    if (!key) return
    bridgeInputs.set(key, Date.now())
    for (const [callId, itemId] of items) {
      const item = session.item<ToolItem>(itemId)
      if (item && item.status !== 'done' && item.status !== 'error' && inputKey(item.input) === key) {
        dropAgentItem(callId)
        break
      }
    }
  })

  const applyToolCall = (update: Json): void => {
    const callId = String(update.toolCallId ?? '')
    if (!callId || skipped.has(callId)) return
    const existing = items.get(callId)
    if ((!existing && isBridgeCall(update)) || (update.rawInput !== undefined && fromBridge(update.rawInput))) {
      if (existing) dropAgentItem(callId)
      else skipped.add(callId)
      return
    }
    const status = String(update.status ?? '')
    const { output, diffs } = contentOf(update, cwd)
    const locations = Array.isArray(update.locations) ? (update.locations as Json[]) : []
    const path = locations[0]?.path ? String(locations[0].path) : ''
    const rawInput = (update.rawInput ?? {}) as Json
    const command = typeof rawInput.command === 'string' ? rawInput.command : Array.isArray(rawInput.command) ? rawInput.command.join(' ') : ''

    if (existing) {
      const current = session.item<ToolItem>(existing)
      const meta: ToolMeta = { ...(current?.meta ?? {}), ...(diffs ? { diffs } : {}), ...(command ? { command } : {}) }
      const finished = status === 'completed' || status === 'failed'
      session.update<ToolItem>(existing, {
        ...(update.title ? { title: oneLine(titleFor(String(update.kind ?? current?.name ?? 'other'), String(update.title), path), 90) } : {}),
        ...(update.kind ? { tool: diffs?.every((d) => d.created) ? 'create' : (KIND_MAP[String(update.kind)] ?? 'other') } : {}),
        ...(output !== undefined ? { output } : {}),
        meta,
        ...(finished
          ? {
              status: current?.status === 'denied' ? 'denied' : status === 'failed' ? 'error' : 'done',
              error: status === 'failed' && current?.status !== 'denied' ? oneLine(output ?? 'Failed', 200) : current?.error,
              endedAt: Date.now()
            }
          : {})
      })
      return
    }

    const kindName = String(update.kind ?? 'other')
    if (kindName === 'think') {
      skipped.add(callId)
      return
    }
    let kind = KIND_MAP[kindName] ?? 'other'
    if (kind === 'edit' && diffs?.length && diffs.every((d) => d.created)) kind = 'create'
    const meta: ToolMeta = { ...(diffs ? { diffs } : {}), ...(command ? { command, cwd } : {}) }
    writer.end()
    const item = session.add<ToolItem>({
      kind: 'tool',
      tool: kind,
      name: kindName,
      title: oneLine(titleFor(kindName, String(update.title ?? ''), path), 90),
      detail: command || (path ? displayPath(cwd, path) : undefined),
      input: rawInput,
      status: status === 'completed' ? 'done' : status === 'failed' ? 'error' : 'running',
      output,
      meta,
      ...(status === 'completed' || status === 'failed' ? { endedAt: Date.now() } : {})
    })
    items.set(callId, item.id)
  }

  rpc.onNotification = (method, rawParams) => {
    if (method !== 'session/update' || connection.replaying) return
    const update = ((rawParams as Json | undefined)?.update ?? {}) as Json
    const content = update.content as Json | undefined
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (content?.type === 'text') writer.text(String(content.text ?? ''))
        break
      case 'agent_thought_chunk':
        if (content?.type === 'text') writer.reasoning(String(content.text ?? ''))
        break
      case 'tool_call':
      case 'tool_call_update':
        applyToolCall(update)
        break
      case 'plan': {
        const entries = Array.isArray(update.entries) ? (update.entries as Json[]) : []
        const tasks: TaskEntry[] = entries.map((e) => ({
          content: String(e.content ?? ''),
          status: e.status === 'completed' ? 'completed' : e.status === 'in_progress' ? 'in_progress' : 'pending'
        }))
        const done = tasks.filter((t) => t.status === 'completed').length
        writer.end()
        session.add<ToolItem>({
          kind: 'tool',
          tool: 'task',
          name: 'plan',
          title: done === 0 ? `Planned ${tasks.length} tasks` : `Updated tasks (${done}/${tasks.length} done)`,
          input: {},
          status: 'done',
          meta: { tasks },
          endedAt: Date.now()
        })
        break
      }
      case 'config_option_update': {
        const next = optionsOf(update)
        connection.options = next.options
        connection.legacy = next.legacy
        session.patchChat({ acpOptions: connection.options })
        break
      }
      case 'current_mode_update': {
        const option = connection.options.find((o) => o.id === LEGACY_MODE && connection.legacy.has(o.id))
        if (option) {
          option.currentValue = String(update.currentModeId ?? option.currentValue)
          session.patchChat({ acpOptions: connection.options })
        }
        break
      }
      case 'usage_update': {
        const used = Number(update.used ?? 0)
        if (used > 0) session.addUsage(0, 0, 0, used)
        break
      }
      default:
        break
    }
  }

  rpc.onRequest = async (method, rawParams) => {
    const params = (rawParams ?? {}) as Json
    switch (method) {
      case 'session/request_permission': {
        const call = (params.toolCall ?? {}) as Json
        const options = Array.isArray(params.options) ? (params.options as Json[]) : []
        const pick = (...kinds: string[]): Json | undefined => kinds.map((k) => options.find((o) => o.kind === k)).find(Boolean)
        const allow = pick('allow_once', 'allow_always') ?? options[0]
        const reject = pick('reject_once', 'reject_always')
        const select = (option: Json | undefined): Json =>
          option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } }

        // Bridge tools are approved inside Galaxy Code when they run.
        if (isBridgeCall(call) || skipped.has(String(call.toolCallId ?? ''))) return select(allow)

        applyToolCall({ ...call, status: 'pending' })
        const itemId = items.get(String(call.toolCallId ?? ''))
        if (!itemId) return select(turn.permissionMode === 'full' ? allow : reject)
        const item = session.item<ToolItem>(itemId)
        const command = item?.meta?.command ?? ''
        const kind = item?.tool ?? 'other'
        const prefix = kind === 'bash' ? commandPrefix(command) : ''
        const verdict = await gate(session, turn.permissionMode, {
          itemId,
          kind,
          action: {
            tool: String(call.kind ?? 'other'),
            title: String(call.title ?? item?.title ?? ''),
            working_directory: cwd,
            ...(command ? { command } : {}),
            ...(item?.meta?.diffs ? { files: item.meta.diffs.map((d) => ({ path: d.path, patch: d.patch.slice(0, 1500) })) } : {}),
            input: call.rawInput ?? null
          },
          sessionKey: kind === 'bash' ? (prefix ? `bash:${prefix}` : undefined) : kind === 'edit' || kind === 'create' ? 'edit' : `tool:${kind}`,
          sessionLabel:
            kind === 'bash'
              ? prefix
                ? `Always allow \`${prefix}\` in this chat`
                : undefined
              : kind === 'edit' || kind === 'create'
                ? 'Allow all edits in this chat'
                : 'Always allow this kind of action in this chat'
        })
        if (verdict.allowed) session.update<ToolItem>(itemId, { status: 'running' })
        return select(verdict.allowed ? allow : reject)
      }
      case 'fs/read_text_file': {
        const path = resolvePath(cwd, String(params.path ?? ''))
        const text = await readFile(path, 'utf8')
        const line = typeof params.line === 'number' ? Math.max(1, params.line) : 1
        const limit = typeof params.limit === 'number' ? params.limit : undefined
        if (line === 1 && limit === undefined) return { content: text }
        const lines = text.split('\n')
        return { content: lines.slice(line - 1, limit !== undefined ? line - 1 + limit : undefined).join('\n') }
      }
      case 'fs/write_text_file': {
        const path = resolvePath(cwd, String(params.path ?? ''))
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, String(params.content ?? ''), 'utf8')
        return {}
      }
      default:
        throw new RpcError(`Method not supported: ${method}`, -32601)
    }
  }

  // Session setup

  // A new session starts without the project's instructions, so its first prompt carries them.
  let newSession = false
  if (!connection.sessionId) {
    const servers = mcpServerList(connection.handle.url, connection.capabilities)
    const saved = session.doc.engine.acpAccount === account ? session.doc.engine.acpSessionId : undefined
    const open = async (): Promise<Json & { sessionId?: string }> => {
      if (saved && connection.capabilities.loadSession) {
        connection.replaying = true
        try {
          const loaded = await rpc.request<Json>('session/load', { sessionId: saved, cwd, mcpServers: servers }, 60000)
          return { ...loaded, sessionId: saved }
        } catch {
          // fall through to a new session
        } finally {
          connection.replaying = false
        }
      }
      newSession = true
      return rpc.request<Json & { sessionId: string }>('session/new', { cwd, mcpServers: servers }, 60000)
    }
    let opened: Json & { sessionId?: string }
    try {
      opened = await open()
      acpSignedIn.set(account, true)
    } catch (err) {
      throw signInError(account, err)
    }
    if (!opened.sessionId) throw new Error(`${label} did not return a session`)
    connection.sessionId = opened.sessionId
    const reported = optionsOf(opened)
    connection.options = reported.options
    connection.legacy = reported.legacy
    session.doc.engine.acpSessionId = opened.sessionId
    session.doc.engine.acpAccount = account
  }
  const sessionId = connection.sessionId
  try {
    await applyConfig(connection, sessionId, session.chat.acpConfig ?? {})
  } catch (err) {
    disposeAcp(session.id)
    throw new Error(`Could not apply the ${label} session options: ${errorMessage(err)}`)
  }
  // Ask and Plan switch the agent to its own matching mode for this turn, or, when it has none, go along as instructions.
  const modeSwitch = turn.mode === 'ask' || turn.mode === 'plan' ? agentModeFor(connection.options, turn.mode) : null
  if (modeSwitch) {
    try {
      await applyConfig(connection, sessionId, { [modeSwitch.option]: modeSwitch.value })
    } catch (err) {
      throw new Error(`Could not switch ${label} to ${turn.mode === 'ask' ? 'Ask' : 'Plan'} mode: ${errorMessage(err)}`)
    }
  }
  const modeNote = turn.mode && !modeSwitch ? MODE_NOTES[turn.mode] : ''
  session.patchChat({ acpOptions: connection.options })
  store.touchDoc(session.id)

  const prompt: Json[] = []
  const others: string[] = []
  const acceptsImages = ((connection.capabilities.promptCapabilities ?? {}) as Json).image === true
  for (const attachment of turn.attachments) {
    if (acceptsImages && isImagePath(attachment.path)) {
      const data = await readFile(attachment.path).catch(() => null)
      if (data) {
        prompt.push({ type: 'image', mimeType: attachment.mime, data: data.toString('base64') })
        continue
      }
    }
    others.push(attachment.path)
  }
  const note = others.length ? `\n\nAttached files:\n${others.map((p) => `- ${p}`).join('\n')}` : ''
  prompt.unshift({ type: 'text', text: [newSession ? acpSystemPrompt(ctx, ACP_TOOLS.map((t) => t.name)) : acpTurnContext(ctx), inlineMentionsBlock(turn.mentions), modeNote, (turn.text || 'See the attached files.') + note].filter(Boolean).join('\n\n') })

  const onAbort = (): void => rpc.notify('session/cancel', { sessionId })
  turn.signal.addEventListener('abort', onAbort, { once: true })
  let failure: string | null = null
  try {
    const result = await Promise.race([
      rpc.request<{ stopReason?: string }>('session/prompt', { sessionId, prompt }),
      new Promise<{ stopReason: string }>((resolve) => {
        // Give a cancelled agent a moment to wind down, then stop waiting.
        turn.signal.addEventListener('abort', () => setTimeout(() => resolve({ stopReason: 'cancelled' }), 5000), { once: true })
      })
    ])
    if (result.stopReason === 'refusal') failure = `${label} declined to continue.`
    else if (result.stopReason === 'max_tokens') session.notice('error', 'The response hit the model output limit and was cut off.')
    else if (result.stopReason === 'max_turn_requests') session.notice('error', `${label} reached its step limit. Send a message to continue.`)
  } catch (err) {
    if (!turn.signal.aborted) {
      failure = errorMessage(signInError(account, err))
    }
  } finally {
    turn.signal.removeEventListener('abort', onAbort)
    writer.end()
    rpc.onNotification = () => {}
    if (connections.get(session.id) === connection) {
      connection.idleTimer = setTimeout(() => disposeAcp(session.id), IDLE_MS)
    }
  }
  if (failure && !turn.signal.aborted) throw new Error(failure)
}
