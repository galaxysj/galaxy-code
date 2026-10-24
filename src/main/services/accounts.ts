import { shell } from 'electron'
import { execFile } from 'node:child_process'
import { ACCOUNT_LABELS, ACP_ACCOUNTS, type AccountId, type AccountStatus } from '@shared/types'
import { acpAgent, acpBaseEnv, acpBinary, acpLaunch } from '../engines/acp'
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

export async function accountStatuses(): Promise<AccountStatus[]> {
  return Promise.all(
    ['claude', 'codex', ...ACP_ACCOUNTS].map(async (id): Promise<AccountStatus> => {
      const binary = await binaryFor(id)
      if (!binary) return { id, installed: false, binary: null, version: null, authenticated: null, detail: null }
      // Do not launch/download the unofficial adapter during background status checks.
      if (id === 'antigravity') return { id, installed: true, binary, version: null, authenticated: null, detail: 'Unofficial adapter' }
      const [ver, auth] = await Promise.all([version(binary), authState(id, binary)])
      return { id, installed: true, binary, version: ver, ...auth }
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

export async function loginAccount(id: AccountId): Promise<{ ok: boolean; message: string }> {
  const label = ACCOUNT_LABELS[id]
  const binary = await binaryFor(id)
  if (!binary) return { ok: false, message: `${label} CLI is not installed` }
  try {
    if (id === 'codex') return await loginCodex()
    if (id === 'antigravity') {
      const launch = await acpLaunch(id, 'ask')
      await openInTerminal([launch.command, ...launch.args, '--login'].map(shellQuote).join(' '))
      return { ok: true, message: 'Finish signing in to Antigravity in the terminal window, then try again.' }
    }
    const args = id === 'claude' ? ['auth', 'login'] : acpAgent(id)?.Login
    if (!args) return { ok: false, message: `Sign in to ${label} from its own app, then check again.` }
    const command = [binary, ...args].map(shellQuote).join(' ')
    await openInTerminal(command)
    return { ok: true, message: `Finish signing in to ${label} in the terminal window, then check again.` }
  } catch (err) {
    return { ok: false, message: errorMessage(err) }
  }
}
