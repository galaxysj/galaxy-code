import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandPrefix } from '../agent/approval'
import { newId, oneLine, truncateMiddle } from '../util'
import { bool, num, str, ToolInputError, type ToolDef } from './types'

const DEFAULT_TIMEOUT_S = 120
const MAX_TIMEOUT_S = 600
const MAX_OUTPUT = 30_000
/** How much of a longer output the agent sees before it is cut. */
const OUTPUT_PREVIEW = 2_000
/** How long a background command runs before the call returns its first output. */
const BACKGROUND_WAIT_MS = 3000

/** A command the Bash tool started. It keeps its stdin open, so the agent can send input or stop it. */
interface Shell {
  id: string
  name: string
  child: ChildProcess
  log: string
  output: string
  code: number | null
  exited: boolean
  chatId: string
  itemId: string
  /** Called with output while someone is waiting on it. */
  listeners: Set<(text: string) => void>
}

const shells = new Map<string, Shell>()
let shellCount = 0

export function stopRevertedBackgroundProcesses(chatId: string, itemIds: Set<string>): void {
  for (const shell of shells.values()) {
    if (shell.chatId !== chatId || !itemIds.has(shell.itemId)) continue
    if (!shell.exited) killTree(shell.child, 'SIGKILL')
    shells.delete(shell.id)
  }
}

function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!child.pid) return
  try {
    // The shell is a process group leader, so this reaches everything it started.
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already exited
    }
  }
}

export function killBackgroundProcesses(): void {
  for (const shell of shells.values()) if (!shell.exited) killTree(shell.child, 'SIGKILL')
  shells.clear()
}

async function startShell(command: string, name: string, cwd: string, chatId: string, itemId: string): Promise<Shell> {
  const program = process.env.SHELL && /(zsh|bash)$/.test(process.env.SHELL) ? process.env.SHELL : '/bin/zsh'
  const dir = join(tmpdir(), 'galaxy-code')
  await mkdir(dir, { recursive: true })
  const log = join(dir, `bg-${newId()}.log`)
  const stream = createWriteStream(log)
  const child = spawn(program, ['-lc', command], { cwd, env: shellEnv(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const shell: Shell = { id: `shell-${++shellCount}`, name, child, log, output: '', code: null, exited: false, chatId, itemId, listeners: new Set() }
  shells.set(shell.id, shell)
  const onData = (chunk: Buffer): void => {
    const text = chunk.toString('utf8')
    shell.output += text
    if (shell.output.length > 400_000) shell.output = shell.output.slice(-300_000)
    stream.write(text)
    for (const listener of shell.listeners) listener(text)
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  // Writing to a process that already exited must not crash the app.
  child.stdin?.on('error', () => {})
  child.on('close', (code) => {
    shell.exited = true
    shell.code = code
    stream.end(`\n[process exited with code ${code}]\n`)
    for (const listener of shell.listeners) listener('')
  })
  child.on('error', (err) => {
    shell.exited = true
    stream.end(`\n[failed to start: ${err.message}]\n`)
    for (const listener of shell.listeners) listener('')
  })
  return shell
}

/** Collects output until the shell exits, `ms` passes, or (with `quietMs`) output stops for that long. */
function collect(shell: Shell, ms: number, onText?: (text: string) => void, quietMs?: number): Promise<string> {
  return new Promise((resolve) => {
    let text = ''
    let quiet: NodeJS.Timeout | undefined
    const finish = (): void => {
      clearTimeout(timer)
      clearTimeout(quiet)
      shell.listeners.delete(listener)
      resolve(text)
    }
    const listener = (chunk: string): void => {
      text += chunk
      if (chunk) onText?.(chunk)
      if (shell.exited) return finish()
      if (quietMs) { clearTimeout(quiet); quiet = setTimeout(finish, quietMs) }
    }
    const timer = setTimeout(finish, ms)
    if (quietMs) quiet = setTimeout(finish, quietMs)
    if (shell.exited) return finish()
    shell.listeners.add(listener)
  })
}

const shellName = (input: Record<string, unknown>): string => {
  const id = String(input.shell_id ?? '')
  return shells.get(id)?.name ?? id
}

const controlHint = (shell: Shell): string => `Send input with Bash shell_id="${shell.id}" and input (end it with \\n to press Enter), or stop it with shell_id="${shell.id}" and stop=true.`

function shellEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TERM: 'dumb',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CI: process.env.CI ?? '',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    ELECTRON_RUN_AS_NODE: undefined
  }
}

export const bashTool: ToolDef = {
  name: 'Bash',
  kind: 'bash',
  description:
    `Run a shell command in the working directory and return its combined stdout and stderr. Each call starts a fresh shell, so use absolute paths or chain with && rather than relying on an earlier cd. The command's stdin stays open, so it can take input. If it is still running after \`timeout\` seconds (default ${DEFAULT_TIMEOUT_S}, maximum ${MAX_TIMEOUT_S}), it keeps running in the background and the call returns its output so far, a shell ID and a log file you can Read. For servers, watchers and other processes that do not exit, set \`run_in_background\`: the call returns after ${BACKGROUND_WAIT_MS / 1000} seconds with the first output. To answer a prompt, pass \`shell_id\` and \`input\`; to stop it, pass \`shell_id\` and \`stop\`. Prefer Read, Grep, Glob and List over cat, grep, find and ls.`,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to run. Leave it out when using shell_id.' },
      description: { type: 'string', description: 'Required. What this call does, in five to ten words, such as "Run the unit tests". It is the title the user sees and names the shell.' },
      timeout: { type: 'integer', description: `Seconds to wait before moving the command to the background. Default ${DEFAULT_TIMEOUT_S}, maximum ${MAX_TIMEOUT_S}.` },
      run_in_background: { type: 'boolean', description: `Start the command and return after ${BACKGROUND_WAIT_MS / 1000} seconds with its first output, without waiting for it to finish.` },
      shell_id: { type: 'string', description: 'A running shell from an earlier Bash call, for input or stop.' },
      input: { type: 'string', description: 'Text to send to the shell\'s stdin. Include \\n to press Enter.' },
      stop: { type: 'boolean', description: 'Stop the shell.' }
    },
    required: ['description']
  },
  present(input, ctx) {
    if (input.shell_id) {
      if (input.stop === true) return { title: `Stopped ${shellName(input)}` }
      return { title: `Sent "${oneLine(String(input.input ?? ''), 40)}" to ${shellName(input)}` }
    }
    const command = String(input.command ?? '')
    return {
      title: input.description ? String(input.description) : oneLine(command, 80),
      detail: command,
      meta: { command, cwd: ctx.cwd, background: input.run_in_background === true }
    }
  },
  approval(input, ctx) {
    // Stopping a shell needs no approval; input can run anything the shell accepts.
    if (input.shell_id) {
      if (input.stop === true) return null
      return { action: { tool: 'Bash', shell: shellName(input), input: String(input.input ?? ''), working_directory: ctx.cwd } }
    }
    const command = String(input.command ?? '')
    const prefix = commandPrefix(command)
    return {
      action: { tool: 'Bash', command, working_directory: ctx.cwd, stated_purpose: input.description ?? null },
      sessionKey: prefix ? `bash:${prefix}` : undefined,
      sessionLabel: prefix ? `Always allow \`${prefix}\` in this chat` : undefined
    }
  },
  async execute(input, ctx) {
    const shellId = str(input, 'shell_id')
    if (shellId) {
      const shell = shells.get(shellId)
      if (!shell) throw new ToolInputError(`No shell with ID ${shellId}.`)
      if (bool(input, 'stop')) {
        if (shell.exited) return { text: `${shell.name} had already exited with code ${shell.code}.` }
        killTree(shell.child)
        const kill = setTimeout(() => killTree(shell.child, 'SIGKILL'), 2000)
        const tail = await collect(shell, 4000)
        clearTimeout(kill)
        return { text: [truncateMiddle(tail.replace(/\s+$/, ''), MAX_OUTPUT), `[stopped ${shell.name}]`].filter(Boolean).join('\n'), display: tail }
      }
      const text = typeof input.input === 'string' ? input.input : undefined
      if (text === undefined) throw new ToolInputError('Pass input or stop=true with shell_id.')
      if (shell.exited) throw new ToolInputError(`${shell.name} has exited with code ${shell.code}. Start a new command instead.`)
      shell.child.stdin?.write(text)
      // Return what the shell printed in reply, once it settles.
      const reply = await collect(shell, 15_000, ctx.onOutput, 1500)
      const notes = shell.exited ? [`[process exited with code ${shell.code}]`] : []
      return { text: [truncateMiddle(reply.replace(/\s+$/, ''), MAX_OUTPUT), ...notes].filter(Boolean).join('\n') || '[no output]', display: reply }
    }

    const command = str(input, 'command', true)
    const name = str(input, 'description') ?? oneLine(command, 40)
    const shell = await startShell(command, name, ctx.cwd, ctx.session.team?.chatId ?? ctx.session.id, ctx.itemId)

    if (bool(input, 'run_in_background')) {
      // Wait a few seconds so the first output, or an immediate failure, comes back right away.
      await collect(shell, BACKGROUND_WAIT_MS, ctx.onOutput)
      const early = shell.exited ? ` It already exited with code ${shell.code}.` : ''
      const first = truncateMiddle(shell.output.replace(/\s+$/, ''), MAX_OUTPUT)
      return {
        text: [first, `[started in the background as ${shell.id} (pid ${shell.child.pid}).${early} Output is being written to ${shell.log}. Read that file to check on it. ${controlHint(shell)}]`].filter(Boolean).join('\n'),
        display: first,
        meta: { background: true, exitCode: shell.code, log: shell.log, shellId: shell.id }
      }
    }

    const timeoutS = Math.min(MAX_TIMEOUT_S, Math.max(1, Math.floor(num(input, 'timeout') ?? DEFAULT_TIMEOUT_S)))
    const onAbort = (): void => {
      killTree(shell.child)
      setTimeout(() => killTree(shell.child, 'SIGKILL'), 1500)
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    await collect(shell, timeoutS * 1000, ctx.onOutput)
    ctx.signal.removeEventListener('abort', onAbort)
    // Long output keeps only its beginning; the log has the rest.
    const trimmed = shell.output.replace(/\s+$/, '')
    const body = trimmed.length > MAX_OUTPUT ? `${trimmed.slice(0, OUTPUT_PREVIEW)}\n…` : trimmed

    if (!shell.exited) {
      // Still running: leave it in the background instead of stopping it.
      return {
        text: [body, `[still running after ${timeoutS}s, so it continues in the background as ${shell.id}. Its output keeps going to ${shell.log}. ${controlHint(shell)}]`].filter(Boolean).join('\n'),
        display: body,
        meta: { background: true, exitCode: null, log: shell.log, shellId: shell.id }
      }
    }
    const code = shell.code
    const notes: string[] = []
    // The log keeps everything the shortened copy leaves out.
    if (trimmed.length > MAX_OUTPUT) notes.push(`[cut after ${OUTPUT_PREVIEW} of ${trimmed.length} characters; the full output is saved to ${shell.log}. This result is incomplete. Unless what you were looking for is already in the part above, your next step must be Read on that file, before you answer, summarize or call any other tool. Do not tell the user the output was cut or ask them to narrow it; read the file.]`)
    if (ctx.signal.aborted) notes.push('[stopped by user]')
    else if (code !== 0 && code !== null) notes.push(`[exit code ${code}]`)
    const text = [body, ...notes].filter(Boolean).join('\n') || '[no output]'
    return { text, display: body, isError: code !== 0 && code !== null, meta: { exitCode: code } }
  }
}
