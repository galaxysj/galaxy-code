import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandPrefix } from '../agent/approval'
import { newId, oneLine, truncateMiddle } from '../util'
import { bool, num, str, type ToolDef } from './types'

const DEFAULT_TIMEOUT_S = 120
const MAX_TIMEOUT_S = 600
const MAX_OUTPUT = 30_000

const background = new Set<ChildProcess>()
const backgroundOwners = new Map<ChildProcess, { chatId: string; itemId: string }>()

export function stopRevertedBackgroundProcesses(chatId: string, itemIds: Set<string>): void {
  for (const [child, owner] of backgroundOwners) {
    if (owner.chatId !== chatId || !itemIds.has(owner.itemId)) continue
    killTree(child, 'SIGKILL')
    background.delete(child)
    backgroundOwners.delete(child)
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
  for (const child of background) killTree(child, 'SIGKILL')
  background.clear()
  backgroundOwners.clear()
}

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
    `Run a shell command in the working directory and return its combined stdout and stderr. Each call starts a fresh shell, so use absolute paths or chain with && rather than relying on an earlier cd. Commands time out after ${DEFAULT_TIMEOUT_S} seconds unless \`timeout\` is set (maximum ${MAX_TIMEOUT_S}). For servers, watchers and other processes that do not exit, set \`run_in_background\`: the call returns immediately with a log file you can Read. Prefer Read, Grep, Glob and List over cat, grep, find and ls. Never run interactive commands that wait for input.`,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to run.' },
      description: { type: 'string', description: 'What this command does, in five to ten words.' },
      timeout: { type: 'integer', description: 'Seconds to wait before stopping the command.' },
      run_in_background: { type: 'boolean', description: 'Start the command and return without waiting for it.' }
    },
    required: ['command']
  },
  present(input, ctx) {
    const command = String(input.command ?? '')
    return {
      title: input.description ? String(input.description) : oneLine(command, 80),
      detail: command,
      meta: { command, cwd: ctx.cwd, background: input.run_in_background === true }
    }
  },
  approval(input, ctx) {
    const command = String(input.command ?? '')
    const prefix = commandPrefix(command)
    return {
      action: { tool: 'Bash', command, working_directory: ctx.cwd, stated_purpose: input.description ?? null },
      sessionKey: prefix ? `bash:${prefix}` : undefined,
      sessionLabel: prefix ? `Always allow \`${prefix}\` in this chat` : undefined
    }
  },
  async execute(input, ctx) {
    const command = str(input, 'command', true)
    const shell = process.env.SHELL && /(zsh|bash)$/.test(process.env.SHELL) ? process.env.SHELL : '/bin/zsh'

    if (bool(input, 'run_in_background')) {
      const dir = join(tmpdir(), 'galaxy-code')
      await mkdir(dir, { recursive: true })
      const log = join(dir, `bg-${newId()}.log`)
      const stream = createWriteStream(log)
      const child = spawn(shell, ['-lc', command], { cwd: ctx.cwd, env: shellEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      background.add(child)
      backgroundOwners.set(child, { chatId: ctx.session.team?.chatId ?? ctx.session.id, itemId: ctx.itemId })
      child.stdout?.pipe(stream, { end: false })
      child.stderr?.pipe(stream, { end: false })
      child.on('close', (code) => {
        background.delete(child)
        backgroundOwners.delete(child)
        stream.end(`\n[process exited with code ${code}]\n`)
      })
      child.on('error', (err) => stream.end(`\n[failed to start: ${err.message}]\n`))
      // Give it a moment so an immediate failure is reported right away.
      await new Promise((r) => setTimeout(r, 1200))
      const early = child.exitCode !== null ? ` It already exited with code ${child.exitCode}.` : ''
      return {
        text: `Started in the background (pid ${child.pid}).${early}\nOutput is being written to ${log}. Read that file to check on it. Stop it with: kill -- -${child.pid}`,
        meta: { background: true, exitCode: child.exitCode, log }
      }
    }

    const timeoutS = Math.min(MAX_TIMEOUT_S, Math.max(1, Math.floor(num(input, 'timeout') ?? DEFAULT_TIMEOUT_S)))
    return new Promise((done) => {
      const child = spawn(shell, ['-lc', command], { cwd: ctx.cwd, env: shellEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      let timedOut = false
      let settled = false

      const onData = (chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        output += text
        if (output.length > 400_000) output = output.slice(-300_000)
        ctx.onOutput(text)
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)

      const timer = setTimeout(() => {
        timedOut = true
        killTree(child)
        setTimeout(() => killTree(child, 'SIGKILL'), 2000)
      }, timeoutS * 1000)

      const onAbort = (): void => {
        killTree(child)
        setTimeout(() => killTree(child, 'SIGKILL'), 1500)
      }
      ctx.signal.addEventListener('abort', onAbort, { once: true })

      const finish = (code: number | null, failure?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        const body = truncateMiddle(output.replace(/\s+$/, ''), MAX_OUTPUT)
        const notes: string[] = []
        if (failure) notes.push(`[failed to start: ${failure}]`)
        if (timedOut) notes.push(`[timed out after ${timeoutS}s and was stopped. For long-running processes use run_in_background.]`)
        else if (ctx.signal.aborted) notes.push('[stopped by user]')
        else if (code !== 0 && code !== null) notes.push(`[exit code ${code}]`)
        const text = [body, ...notes].filter(Boolean).join('\n') || '[no output]'
        done({ text, display: body, isError: !!failure || timedOut || (code !== 0 && code !== null), meta: { exitCode: code } })
      }
      child.on('error', (err) => finish(null, err.message))
      child.on('close', (code) => finish(code))
    })
  }
}
