import { tmpdir } from 'node:os'
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { codexBinary, startCodexProcess } from '../engines/codex'
import type { RpcProcess } from '../engines/jsonrpc'
import { store } from '../store'
import { which } from '../util'

/**
 * Warm Claude and Codex processes for utility text (tab completion, Ctrl+I, commit
 * messages), so a request does not start a CLI each time. Each request still starts
 * from an empty conversation. A worker closes after it has been idle for a while.
 */

type Json = Record<string, unknown>

export interface WorkerRequest {
  system: string
  prompt: string
  cwd: string
  signal: AbortSignal
  onText?: (text: string) => void
}

const IDLE_MS = 10 * 60 * 1000

function abortError(): Error {
  return new Error('Cancelled')
}

// Claude

/** One Claude Code session per model. Requests run one at a time, and /clear empties the conversation between them. */
class ClaudeWorker {
  private q: Query
  private inbox: SDKUserMessage[] = []
  private wake: (() => void) | null = null
  private closed = false
  private chain: Promise<unknown> = Promise.resolve()
  private onMessage: ((message: Json) => void) | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(model: string, executable: string | null, private onClose: () => void) {
    const controller = new AbortController()
    const self = this
    async function* input(): AsyncGenerator<SDKUserMessage> {
      while (!self.closed) {
        const next = self.inbox.shift()
        if (next) yield next
        else await new Promise<void>((resolve) => (self.wake = resolve))
      }
    }
    this.q = query({
      prompt: input(),
      options: {
        cwd: tmpdir(),
        model,
        abortController: controller,
        includePartialMessages: true,
        tools: [],
        settingSources: [],
        persistSession: false,
        thinking: { type: 'disabled' },
        systemPrompt: 'You are a text tool inside a code editor. Each message carries its own instructions; follow them exactly and reply with only the requested text. Earlier messages, if any, are unrelated.',
        env: { ...(process.env as Record<string, string>), CLAUDE_AGENT_SDK_CLIENT_APP: 'galaxy-code/0.1.0' },
        ...(executable ? { pathToClaudeCodeExecutable: executable } : {})
      }
    })
    void (async () => {
      try {
        for await (const message of this.q) this.onMessage?.(message as unknown as Json)
      } catch {
        // The failure reaches the waiting request through close().
      }
      this.close()
    })()
  }

  private send(text: string): void {
    this.inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null } as SDKUserMessage)
    this.wake?.()
    this.wake = null
  }

  /** Sends one message and waits for its result. */
  private turn(text: string, onText?: (text: string) => void, signal?: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let streamed = ''
      let aborted = false
      const onAbort = (): void => {
        aborted = true
        void this.q.interrupt().catch(() => {})
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.onMessage = (message) => {
        if (message.type === 'stream_event') {
          const event = message.event as { type?: string; delta?: { type?: string; text?: string } }
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
            streamed += event.delta.text
            onText?.(streamed)
          }
        } else if (message.type === 'result') {
          this.onMessage = null
          signal?.removeEventListener('abort', onAbort)
          if (aborted) reject(abortError())
          else if (message.subtype === 'success') resolve(String(message.result ?? streamed))
          else reject(new Error(`Claude could not reply (${String(message.subtype)})`))
        } else if (message.type === 'closed') {
          reject(new Error('Claude stopped'))
        }
      }
      this.send(text)
    })
  }

  run(request: WorkerRequest): Promise<string> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    const job = this.chain.then(async () => {
      if (this.closed) throw new Error('Claude stopped')
      if (request.signal.aborted) throw abortError()
      try {
        return await this.turn(`<instructions>\n${request.system}\n</instructions>\n\n${request.prompt}`, request.onText, request.signal)
      } finally {
        if (!this.closed) await this.turn('/clear').catch(() => {})
      }
    })
    this.chain = job.catch(() => {}).then(() => {
      if (this.idleTimer) clearTimeout(this.idleTimer)
      this.idleTimer = setTimeout(() => this.close(), IDLE_MS)
    })
    return job
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.onMessage?.({ type: 'closed' })
    this.onMessage = null
    this.wake?.()
    this.q.close()
    this.onClose()
  }
}

const claudeWorkers = new Map<string, ClaudeWorker>()

export async function claudeUtility(model: string, request: WorkerRequest): Promise<string> {
  let worker = claudeWorkers.get(model)
  if (!worker) {
    const account = store.settings.accounts.claude
    const executable = account.binaryPath.trim() ? await which(account.binaryPath.trim()) : await which('claude')
    const created: ClaudeWorker = new ClaudeWorker(model, executable, () => {
      if (claudeWorkers.get(model) === created) claudeWorkers.delete(model)
    })
    worker = created
    claudeWorkers.set(model, worker)
  }
  return worker.run(request)
}

// Codex

/** One Codex app-server for every model. Each request gets its own ephemeral thread, so requests can overlap. */
class CodexWorker {
  private handlers = new Map<string, (method: string, params: Json) => void>()
  private exitListeners = new Set<(reason: string) => void>()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private active = 0

  constructor(private rpc: RpcProcess, private binary: string, onClose: () => void) {
    rpc.onNotification = (method, rawParams) => {
      const params = (rawParams ?? {}) as Json
      const threadId = typeof params.threadId === 'string' ? params.threadId : null
      if (threadId) this.handlers.get(threadId)?.(method, params)
    }
    // Nothing runs on these threads that could ask; decline anything that does.
    rpc.onRequest = async () => ({ decision: 'decline' })
    rpc.onExit((reason) => {
      onClose()
      for (const listener of this.exitListeners) listener(reason)
    })
  }

  matches(binary: string): boolean {
    return this.rpc.alive && this.binary === binary
  }

  async run(model: string, request: WorkerRequest): Promise<string> {
    if (request.signal.aborted) throw abortError()
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.active++
    let threadId: string | null = null
    let onExit: ((reason: string) => void) | null = null
    try {
      const started = await this.rpc.request<{ thread: { id: string } }>(
        'thread/start',
        { cwd: request.cwd, model, approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: request.system, ephemeral: true },
        60000
      )
      const id = started.thread.id
      threadId = id
      let text = ''
      let turnId: string | null = null
      const reply = new Promise<string>((resolve, reject) => {
        onExit = (reason) => reject(new Error(reason))
        this.exitListeners.add(onExit)
        request.signal.addEventListener('abort', () => {
          if (turnId) void this.rpc.request('turn/interrupt', { threadId: id, turnId }, 5000).catch(() => {})
          reject(abortError())
        }, { once: true })
        this.handlers.set(id, (method, params) => {
          if (method === 'item/agentMessage/delta') {
            text += String(params.delta ?? '')
            request.onText?.(text)
          } else if (method === 'item/completed') {
            const item = params.item as Json
            if (item.type === 'agentMessage' && item.text) text = String(item.text)
          } else if (method === 'turn/completed') {
            const done = params.turn as Json
            if (done.status === 'failed') reject(new Error(String((done.error as Json | null)?.message ?? 'Codex could not complete the turn')))
            else resolve(text)
          }
        })
      })
      const turn = await this.rpc.request<{ turn: { id: string } }>('turn/start', {
        threadId: id,
        input: [{ type: 'text', text: request.prompt, text_elements: [] }],
        cwd: request.cwd,
        model,
        effort: 'low',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false }
      })
      turnId = turn.turn.id
      if (request.signal.aborted) void this.rpc.request('turn/interrupt', { threadId: id, turnId }, 5000).catch(() => {})
      return await reply
    } finally {
      if (threadId) this.handlers.delete(threadId)
      if (onExit) this.exitListeners.delete(onExit)
      this.active--
      if (this.active === 0) this.idleTimer = setTimeout(() => this.close(), IDLE_MS)
    }
  }

  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.rpc.kill()
  }
}

let codexWorker: CodexWorker | null = null
let codexStarting: Promise<CodexWorker> | null = null

export async function codexUtility(model: string, request: WorkerRequest): Promise<string> {
  const binary = (await codexBinary()) ?? ''
  if (!codexWorker?.matches(binary)) {
    codexWorker?.close()
    codexWorker = null
    codexStarting ??= startCodexProcess([], tmpdir()).then((rpc) => {
      const worker: CodexWorker = new CodexWorker(rpc, binary, () => {
        if (codexWorker === worker) codexWorker = null
      })
      codexWorker = worker
      return worker
    }).finally(() => {
      codexStarting = null
    })
    await codexStarting
  }
  return codexWorker!.run(model, request)
}

/** Closes every warm worker, on quit or when an account changes. */
export function disposeAccountWorkers(): void {
  for (const worker of [...claudeWorkers.values()]) worker.close()
  claudeWorkers.clear()
  codexWorker?.close()
  codexWorker = null
}
