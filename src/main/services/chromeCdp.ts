import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

export type CdpParameters = Record<string, unknown>

interface CdpMessage {
  id?: number
  method?: string
  sessionId?: string
  params?: CdpParameters
  result?: unknown
  error?: { message: string }
}

const COMMAND_TIMEOUT = 15000

/** Chrome's debugging pipe reads on fd 3 and writes on fd 4. Frames end with a NUL byte. */
export class ChromeCdp {
  private readonly child: ChildProcess
  private readonly input: Writable
  private readonly decoder = new StringDecoder('utf8')
  private readonly pending = new Map<number, (error: Error | null, result?: unknown) => void>()
  private buffer = ''
  private nextId = 0
  private failure: Error | null = null

  onEvent: (method: string, params: CdpParameters, sessionId?: string) => void = () => {}

  constructor(executable: string, profile: string) {
    this.child = spawn(executable, [
      '--remote-debugging-pipe',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-startup-window',
      `--user-data-dir=${profile}`
    ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
    this.input = this.child.stdio[3] as Writable
    const output = this.child.stdio[4] as Readable
    output.on('data', (chunk: Buffer) => this.receive(this.decoder.write(chunk)))
    output.on('end', () => this.fail(new Error('Chrome disconnected.')))
    output.on('error', (err) => this.fail(err))
    this.input.on('error', (err) => this.fail(err))
    this.child.on('error', (err) => this.fail(new Error(`Could not start Chrome: ${err.message}`)))
    this.child.on('close', (code) => this.fail(new Error(`Chrome closed${code ? ` (exit code ${code})` : ''}.`)))
  }

  get alive(): boolean { return !this.failure }

  private receive(chunk: string): void {
    this.buffer += chunk
    let boundary: number
    while ((boundary = this.buffer.indexOf('\0')) >= 0) {
      const payload = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 1)
      let message: CdpMessage
      try {
        message = JSON.parse(payload) as CdpMessage
      } catch {
        this.fail(new Error('Chrome returned an invalid DevTools message.'))
        return
      }
      if (message.id !== undefined) {
        const finish = this.pending.get(message.id)
        finish?.(message.error ? new Error(message.error.message) : null, message.result)
      } else if (message.method) {
        this.onEvent(message.method, message.params ?? {}, message.sessionId)
      }
    }
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const finish of this.pending.values()) finish(error)
    // Closing the pipe lets Chrome shut down and flush its profile. Terminate a stuck process.
    this.input.destroy()
    const cleanup = setTimeout(() => this.child.kill(), 2000)
    cleanup.unref()
    this.child.once('exit', () => clearTimeout(cleanup))
  }

  async send<T = void>(method: string, params?: CdpParameters, sessionId?: string, signal?: AbortSignal, timeout = COMMAND_TIMEOUT): Promise<T> {
    signal?.throwIfAborted()
    if (this.failure) throw this.failure
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const finish = (error: Error | null, result?: unknown): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        this.pending.delete(id)
        if (error) reject(error)
        else resolve(result as T)
      }
      const cancel = (): void => finish(new DOMException('Chrome action cancelled', 'AbortError'))
      const timer = setTimeout(() => finish(new Error(`Chrome did not answer ${method} in ${timeout / 1000} seconds.`)), timeout)
      this.pending.set(id, finish)
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        this.input.write(JSON.stringify({ id, method, params, sessionId }) + '\0')
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  close(): void {
    this.fail(new Error('Chrome connection closed.'))
  }
}
