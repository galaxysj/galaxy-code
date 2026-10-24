import { spawn, type ChildProcess } from 'node:child_process'

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

export interface RpcOptions {
  command: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Include `"jsonrpc": "2.0"` on outgoing messages. ACP needs it, Codex omits it. */
  strict?: boolean
}

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void }

/** Newline-delimited JSON-RPC over a child process's stdio, in both directions. */
export class RpcProcess {
  private child: ChildProcess
  private nextId = 1
  private pending = new Map<number | string, Pending>()
  private buffer = ''
  private stderrTail: string[] = []
  private closed = false
  private exitListeners = new Set<(reason: string) => void>()

  onNotification: (method: string, params: unknown) => void = () => {}
  /** Handles requests from the process. Return the result, or throw to send an error. */
  onRequest: (method: string, params: unknown) => Promise<unknown> = async (method) => {
    throw new RpcError(`Method not supported: ${method}`, -32601)
  }

  constructor(private options: RpcOptions) {
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child.stdout?.setEncoding('utf8')
    this.child.stdout?.on('data', (chunk: string) => this.onData(chunk))
    this.child.stderr?.setEncoding('utf8')
    this.child.stderr?.on('data', (chunk: string) => {
      this.stderrTail.push(chunk)
      if (this.stderrTail.length > 30) this.stderrTail.shift()
    })
    this.child.on('error', (err) => this.fail(`Could not start ${options.command}: ${err.message}`))
    this.child.on('close', (code, signal) => {
      const detail = this.stderr()
      this.fail(`${options.command} exited${code !== null ? ` with code ${code}` : signal ? ` (${signal})` : ''}${detail ? `: ${detail}` : ''}`)
    })
    // Writing to a process that already died must not take the app down.
    this.child.stdin?.on('error', () => {})
  }

  get alive(): boolean {
    return !this.closed
  }

  stderr(): string {
    return this.stderrTail.join('').trim().split('\n').slice(-5).join('\n')
  }

  onExit(listener: (reason: string) => void): void {
    this.exitListeners.add(listener)
  }

  private fail(reason: string): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(new Error(reason))
    this.pending.clear()
    for (const listener of this.exitListeners) listener(reason)
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed) return
    const payload = this.options.strict ? { jsonrpc: '2.0', ...message } : message
    this.child.stdin?.write(JSON.stringify(payload) + '\n')
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      this.dispatch(message)
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    const id = message.id as number | string | undefined
    const method = message.method as string | undefined

    if (method && id !== undefined && id !== null) {
      this.onRequest(method, message.params)
        .then((result) => this.write({ id, result: result ?? {} }))
        .catch((err: unknown) => {
          const code = err instanceof RpcError && err.code ? err.code : -32603
          this.write({ id, error: { code, message: err instanceof Error ? err.message : String(err) } })
        })
      return
    }
    if (method) {
      try {
        this.onNotification(method, message.params)
      } catch (err) {
        console.error(`[rpc] notification handler failed for ${method}`, err)
      }
      return
    }
    if (id !== undefined && id !== null) {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      const error = message.error as { message?: string; code?: number; data?: unknown } | undefined
      if (error) pending.reject(new RpcError(error.message ?? 'Request failed', error.code, error.data))
      else pending.resolve(message.result)
    }
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`${this.options.command} is not running`))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id)
            reject(new Error(`${method} timed out`))
          }, timeoutMs)
        : null
      this.pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer)
          resolve(value as T)
        },
        reject: (err) => {
          if (timer) clearTimeout(timer)
          reject(err)
        }
      })
      this.write({ id, method, ...(params !== undefined ? { params } : {}) })
    })
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params !== undefined ? { params } : {}) })
  }

  kill(): void {
    if (this.closed) return
    try {
      this.child.stdin?.end()
      this.child.kill('SIGTERM')
    } catch {
      // already gone
    }
    setTimeout(() => {
      try {
        if (this.child.exitCode === null) this.child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }, 2000)
    this.fail('Process stopped')
  }
}
