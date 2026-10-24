import type { IPty } from 'node-pty'
import { homedir } from 'node:os'
import { stat } from 'node:fs/promises'
import type { UiEvent } from '@shared/types'
import { newId } from '../util'

class Terminals {
  private sessions = new Map<string, IPty>()
  private starting = new Map<string, Promise<string>>()
  private output = new Map<string, string>()
  private directories = new Map<string, string>()
  emit: (event: UiEvent) => void = () => {}

  async create(cwd: string, id = newId('terminal_')): Promise<string> {
    if (this.sessions.has(id)) return id
    const pending = this.starting.get(id)
    if (pending) return pending
    const job = this.start(cwd, id)
    this.starting.set(id, job)
    try { return await job } finally { this.starting.delete(id) }
  }

  private async start(cwd: string, id: string): Promise<string> {
    const directory = cwd || homedir()
    if (!(await stat(directory)).isDirectory()) throw new Error('Terminal working directory is not a folder.')
    const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
    // Load the native module only when a terminal is requested.
    const { spawn } = await import('node-pty')
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && key !== 'ELECTRON_RUN_AS_NODE')) as Record<string, string>
    const child = spawn(shell, process.platform === 'win32' ? [] : ['-il'], { name: 'xterm-256color', cols: 100, rows: 30, cwd: directory, env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } })
    this.output.set(id, '')
    this.sessions.set(id, child)
    this.directories.set(id, directory)
    const output = (text: string): void => {
      this.output.set(id, ((this.output.get(id) ?? '') + text).slice(-200_000))
      this.emit({ type: 'terminal-output', tabId: id, text })
    }
    child.onData(output)
    child.onExit(({ exitCode }) => {
      if (this.sessions.get(id) !== child) return
      this.sessions.delete(id)
      this.directories.delete(id)
      const text = `\n[Process exited ${exitCode}]\n`
      this.output.set(id, ((this.output.get(id) ?? '') + text).slice(-200_000))
      this.emit({ type: 'terminal-output', tabId: id, text, exited: true })
    })
    return id
  }
  write(id: string, text: string): void {
    const child = this.sessions.get(id)
    if (!child) throw new Error('This terminal has exited. Open a new terminal.')
    child.write(text)
  }
  read(id: string): string { return this.output.get(id) ?? '' }
  resize(id: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 1000) return
    this.sessions.get(id)?.resize(cols, rows)
  }
  list(): { tabId: string; cwd: string }[] { return [...this.sessions.keys()].map((tabId) => ({ tabId, cwd: this.directories.get(tabId) ?? '' })) }
  interrupt(id: string): void {
    this.write(id, '\x03')
  }
  close(id: string): void {
    const child = this.sessions.get(id)
    this.sessions.delete(id)
    this.output.delete(id)
    this.directories.delete(id)
    if (!child) return
    try { child.kill() } catch { /* The shell may already have exited. */ }
  }
  closeAll(): void { for (const id of this.sessions.keys()) this.close(id) }
}

export const terminals = new Terminals()
