import { shell } from 'electron'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { ACCOUNT_LABELS, ACP_ACCOUNTS, type AccountId, type AccountStatus } from '@shared/types'
import { acpAgent, acpBaseEnv, acpBinary, acpCommand, acpLaunch, acpSignedIn, probeAcpOptions } from '../engines/acp'
import { RpcProcess } from '../engines/jsonrpc'
import { codexBinary, startCodexProcess } from '../engines/codex'
import { store } from '../store'
import { errorMessage, run, which } from '../util'

async function binaryFor(id: AccountId): Promise<string | null> {
  if (id === 'claude') return which(store.settings.accounts.claude.binaryPath.trim() || 'claude')
  if (id === 'codex') return codexBinary()
  return acpBinary(id)
}

async function version(binary: string): Promise<string | null> {
  const result = await run(binary, ['--version'], { timeout: 8000 })
  const match = (result.stdout || result.stderr).match(/\d+\.\d+\.\d+[\w.-]*/)
  return match ? match[0] : null
}

async function authState(id: AccountId, binary: string): Promise<{ authenticated: boolean | null; detail: string | null }> {
  try {
    if (id === 'claude') {
      const result = await run(binary, ['auth', 'status'], { timeout: 10000 })
      const json = JSON.parse(result.stdout) as { loggedIn?: boolean; subscriptionType?: string; authMethod?: string }
      const plan = json.subscriptionType ? json.subscriptionType[0].toUpperCase() + json.subscriptionType.slice(1) : null
      return { authenticated: json.loggedIn === true, detail: json.loggedIn ? (plan ? `${plan} plan` : (json.authMethod ?? null)) : null }
    }
    if (id === 'codex') {
      const result = await run(binary, ['login', 'status'], { timeout: 10000 })
      const text = (result.stdout + result.stderr).trim()
      const loggedIn = /logged in/i.test(text) && !/not logged in/i.test(text)
      return { authenticated: loggedIn, detail: loggedIn ? text.split('\n')[0].replace(/^Logged in /i, 'Signed in ') : null }
    }
    const agent = acpAgent(id)
    const check = agent?.Status
    if (agent && check) {
      // Same environment the agent runs in, so keys it will not see do not count as signed in.
      const result = await run(binary, check.Args, { timeout: 10000, env: acpBaseEnv(agent) })
      const text = result.stdout + result.stderr
      if (check.SignedOut && new RegExp(check.SignedOut, 'i').test(text)) return { authenticated: false, detail: null }
      if (check.SignedIn && new RegExp(check.SignedIn, 'i').test(text)) return { authenticated: true, detail: 'Signed in' }
    }
  } catch {
    // unknown
  }
  return { authenticated: null, detail: null }
}

/**
 * Whether an ACP agent with no status command is signed in, found by opening a session as the composer does:
 * it opens when signed in and asks for sign-in when not. The probe is cached, so this costs one start per agent.
 */
const unknownSince = new Map<AccountId, number>()

async function probedSignIn(id: AccountId): Promise<boolean | null> {
  const known = acpSignedIn.get(id)
  if (known !== undefined) return known
  // Status checks run on every window focus; an agent that failed for another reason is not restarted each time.
  if (Date.now() - (unknownSince.get(id) ?? 0) < 60000) return null
  const probe = probeAcpOptions(id, homedir()).then(() => true, () => {
    const state = acpSignedIn.get(id) ?? null
    if (state === null) unknownSince.set(id, Date.now())
    return state
  })
  // A slow agent leaves the state unknown rather than holding up every other account.
  return Promise.race([probe, new Promise<null>((done) => setTimeout(() => done(null), 20000))])
}

export async function accountStatuses(): Promise<AccountStatus[]> {
  return Promise.all(
    ['claude', 'codex', ...ACP_ACCOUNTS].map(async (id): Promise<AccountStatus> => {
      const binary = await binaryFor(id)
      // A registry release downloads when the agent first starts, never during a status check.
      if (acpAgent(id)?.RegistryId && !store.settings.accounts[id]?.binaryPath.trim()) {
        // Only a release already downloaded is started to check its sign-in.
        return { id, installed: true, binary, version: null, authenticated: binary ? await probedSignIn(id) : (acpSignedIn.get(id) ?? null), detail: binary ? null : 'Downloads on first use' }
      }
      if (!binary) return { id, installed: false, binary: null, version: null, authenticated: null, detail: null }
      // A package runner stands in for an agent that is not installed; asking it for a version would answer for the runner.
      const runner = (await acpCommand(id))?.prefix.length ? acpAgent(id)?.Runner?.Command : acpAgent(id)?.Registry ? /^(npx|uvx)(\.cmd)?$/.exec(basename(binary))?.[1] : undefined
      if (runner) return { id, installed: true, binary, version: null, authenticated: await probedSignIn(id), detail: `Runs with ${runner}` }
      const [ver, auth] = await Promise.all([version(binary), authState(id, binary)])
      // Agents with no status command are started once to see whether they ask for sign-in.
      return { id, installed: true, binary, version: ver, ...auth, authenticated: auth.authenticated ?? (ACP_ACCOUNTS.includes(id) ? await probedSignIn(id) : null) }
    })
  )
}

/** Runs a CLI's interactive login in the user's terminal, since those flows expect a TTY. */
function openInTerminal(command: string): Promise<void> {
  return new Promise((done, fail) => {
    if (process.platform === 'darwin') {
      const script = `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(command)}\nend tell`
      execFile('osascript', ['-e', script], (err) => (err ? fail(err) : done()))
    } else if (process.platform === 'win32') {
      execFile('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', command], (err) => (err ? fail(err) : done()))
    } else {
      execFile('x-terminal-emulator', ['-e', command], (err) => (err ? fail(err) : done()))
    }
  })
}

function shellQuote(value: string): string {
  return /^[\w./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

async function loginCodex(): Promise<{ ok: boolean; message: string }> {
  const rpc = await startCodexProcess()
  try {
    const started = await rpc.request<{ type: string; authUrl?: string; loginId?: string }>('account/login/start', { type: 'chatgpt' }, 30000)
    if (!started.authUrl) return { ok: true, message: 'Codex is signed in' }
    const completed = new Promise<{ ok: boolean; message: string }>((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, message: 'Sign-in timed out' }), 5 * 60 * 1000)
      rpc.onNotification = (method, params) => {
        if (method !== 'account/login/completed') return
        clearTimeout(timer)
        const result = params as { success?: boolean; error?: string | null }
        resolve(result.success ? { ok: true, message: 'Signed in to Codex' } : { ok: false, message: result.error || 'Sign-in failed' })
      }
      rpc.onExit((reason) => {
        clearTimeout(timer)
        resolve({ ok: false, message: reason })
      })
    })
    await shell.openExternal(started.authUrl)
    return await completed
  } finally {
    rpc.kill()
  }
}

type Json = Record<string, unknown>

/** A shell line that runs a command with extra environment variables. */
function shellLine(command: string[], env: Record<string, string> = {}): string {
  return [...Object.entries(env).map(([name, value]) => `${name}=${shellQuote(value)}`), ...command.map(shellQuote)].join(' ')
}

/**
 * Signs in to an ACP agent the way the protocol describes: the agent lists its sign-in methods when it starts.
 * A terminal method runs in the user's terminal; any other is asked of the agent, which usually opens a browser.
 */
async function loginAcp(id: AccountId, label: string): Promise<{ ok: boolean; message: string }> {
  const launch = await acpLaunch(id, 'ask')
  const rpc = new RpcProcess({ ...launch, cwd: homedir(), strict: true })
  const inTerminal = async (command: string[], env?: Record<string, string>): Promise<{ ok: boolean; message: string }> => {
    await openInTerminal(shellLine(command, env))
    // Whether it worked shows the next time the agent starts.
    acpSignedIn.delete(id)
    return { ok: true, message: `Finish signing in to ${label} in the terminal window, then check again.` }
  }
  try {
    const init = await rpc.request<Json>(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: true }, _meta: { 'terminal-auth': true } },
        clientInfo: { name: 'galaxy-code', title: 'Galaxy Code', version: '0.1.0' }
      },
      id === 'antigravity' ? 180000 : 30000
    )
    const methods = Array.isArray(init.authMethods) ? (init.authMethods as Json[]) : []
    // An older convention puts the terminal command in _meta; the protocol's own terminal method reruns the agent with its args.
    const legacy = methods.map((method) => (method._meta as Json | undefined)?.['terminal-auth'] as Json | undefined).find((meta) => meta?.command)
    if (legacy) return await inTerminal([String(legacy.command), ...((legacy.args as string[] | undefined) ?? [])], { ...((legacy.env as Record<string, string> | undefined) ?? {}) })
    const agentMethod = methods.find((method) => !method.type || method.type === 'agent')
    if (agentMethod) {
      await rpc.request('authenticate', { methodId: agentMethod.id }, 5 * 60 * 1000)
      acpSignedIn.set(id, true)
      return { ok: true, message: `Signed in to ${label}` }
    }
    const terminal = methods.find((method) => method.type === 'terminal')
    if (terminal) return await inTerminal([launch.command, ...launch.args, ...((terminal.args as string[] | undefined) ?? [])], (terminal.env as Record<string, string> | undefined) ?? {})
    const login = acpAgent(id)?.Login
    if (login) return await inTerminal([launch.command, ...login])
    return { ok: false, message: `${label} does not offer a sign-in. Sign in with its own CLI, then check again.` }
  } catch (err) {
    // Agents that cannot sign in over the protocol often name the command that does.
    const command = errorMessage(err).match(/[Rr]un `([^`]+)`/)?.[1]
    if (command) {
      await openInTerminal(command)
      acpSignedIn.delete(id)
      return { ok: true, message: `Finish signing in to ${label} in the terminal window, then check again.` }
    }
    throw err
  } finally {
    rpc.kill()
  }
}

export async function loginAccount(id: AccountId): Promise<{ ok: boolean; message: string }> {
  const label = ACCOUNT_LABELS[id]
  const binary = await binaryFor(id)
  if (!binary && !acpAgent(id)?.RegistryId) return { ok: false, message: `${label} CLI is not installed` }
  try {
    if (id === 'codex') return await loginCodex()
    if (ACP_ACCOUNTS.includes(id) && !acpAgent(id)?.Login) return await loginAcp(id, label)
    const args = id === 'claude' ? ['auth', 'login'] : acpAgent(id)?.Login
    if (!binary || !args) return { ok: false, message: `Sign in to ${label} from its own app, then check again.` }
    const prefix = id === 'claude' ? [] : ((await acpCommand(id))?.prefix ?? [])
    const command = [binary, ...prefix, ...args].map(shellQuote).join(' ')
    await openInTerminal(command)
    return { ok: true, message: `Finish signing in to ${label} in the terminal window, then check again.` }
  } catch (err) {
    return { ok: false, message: errorMessage(err) }
  }
}
