import type { Chat, ChatEvent, ToolItem, Item } from '@shared/types'
import { disposeAcp } from '../engines/acp'
import { disposeCodex } from '../engines/codex'
import type { SubagentRequest } from '../tools/types'
import { errorMessage } from '../util'
import { Session, type Turn } from './session'

interface AgentMessage { from: string; to: string; text: string; ts: number }
interface Worker { id: string; name: string; parent: string; state: 'running' | 'done' | 'error'; report: string; job: Promise<void> }

/** A turn-scoped team: separate model contexts, one visible chat, and addressed inboxes. */
export class AgentTeam {
  private workers = new Map<string, Worker>()
  private inboxes = new Map<string, AgentMessage[]>([['main', []]])
  private listeners = new Map<string, Set<() => void>>()
  private closed = false

  constructor(private root: Session, private turn: Turn, private run: (session: Session, turn: Turn) => Promise<void>) {}

  list(): string {
    return JSON.stringify([{ id: 'main', name: 'Main', state: 'running' }, ...[...this.workers.values()].map(({ id, name, parent, state }) => ({ id, name, parent, state }))])
  }

  name(id: string): string { return id === 'main' ? 'Main' : this.workers.get(id)?.name ?? id }
  get chatId(): string { return this.root.id }

  send(from: string, to: string, text: string): void {
    if (this.closed) throw new Error('This agent team has finished.')
    if (!this.inboxes.has(from) || !this.inboxes.has(to)) throw new Error(`Unknown agent. Use Message with action=list to find agent IDs.`)
    const worker = this.workers.get(to)
    if (worker && worker.state !== 'running') throw new Error(`Agent ${to} has finished. Start a new Agent for follow-up work.`)
    this.inboxes.get(to)!.push({ from, to, text, ts: Date.now() })
    for (const listener of this.listeners.get(to) ?? []) listener()
  }

  read(id: string): AgentMessage[] {
    const inbox = this.inboxes.get(id)
    if (!inbox) throw new Error('Unknown agent inbox.')
    return inbox.splice(0)
  }

  subscribe(id: string, listener: () => void): () => void {
    const listeners = this.listeners.get(id) ?? new Set<() => void>()
    this.listeners.set(id, listeners)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  async wait(id?: string, caller = 'main'): Promise<string> {
    if (id) {
      const worker = this.workers.get(id)
      if (!worker) throw new Error('Unknown subagent ID.')
      if (caller !== 'main' && worker.parent !== caller) throw new Error('Workers may only wait for their own children. Use send/read to coordinate with other agents.')
      await worker.job
      return worker.report
    }
    // Workers can start additional workers while they run.
    while ([...this.workers.values()].some((worker) => worker.state === 'running' && (caller === 'main' || worker.parent === caller))) {
      await Promise.all([...this.workers.values()].filter((worker) => worker.state === 'running' && (caller === 'main' || worker.parent === caller)).map((worker) => worker.job))
    }
    return [...this.workers.values()].map((worker) => `${worker.id}: ${worker.report}`).join('\n\n')
  }

  has(id: string): boolean { return this.workers.has(id) }

  /** Subagents still working, by ID. */
  runningIds(): Set<string> { return new Set([...this.workers.values()].filter((worker) => worker.state === 'running').map((worker) => worker.id)) }

  hasRunning(): boolean { return [...this.workers.values()].some((worker) => worker.state === 'running') }

  async spawn(request: SubagentRequest, caller: Session): Promise<string> {
    if (this.closed || request.signal.aborted) throw new Error('The agent team has stopped.')
    if ([...this.workers.values()].filter((worker) => worker.state === 'running').length >= 32) throw new Error('32 subagents are already running. Wait for one to finish before starting another.')
    const id = request.itemId
    const worker: Worker = { id, name: request.description, parent: caller.agentId, state: 'running', report: '', job: Promise.resolve() }
    this.workers.set(id, worker)
    this.inboxes.set(id, [])
    const emit = (event: ChatEvent): void => {
      if (event.type === 'item') {
        const item = { ...event.item, parentId: event.item.parentId ?? id }
        if (this.root.item(item.id)) this.root.update<Item>(item.id, item)
        else this.root.add(item)
      } else if (event.type === 'delta') {
        const item = this.root.item(event.itemId) as unknown as Record<string, string> | undefined
        const previous = item?.[event.field] ?? ''
        this.root.append(event.itemId, event.field, event.delta.slice(Math.max(0, previous.length - event.offset)))
      }
    }
    const session = new WorkerSession({ ...this.root.chat, id, queued: [], status: 'running', usage: { inputTokens: 0, outputTokens: 0, cost: 0, contextTokens: 0 } }, emit, (event) => this.root.emitUi('chatId' in event ? { ...event, chatId: this.root.chat.id } : event), { items: [], engine: {} })
    session.cwd = () => this.root.cwd()
    session.ask = async () => null
    session.team = this
    session.agentId = id
    const prompt = `You are a full-access Galaxy Code subagent. Your ID is ${id}; your parent is ${caller.agentId}. Use all available tools except user-question tools. Work autonomously. Use galaxy.Agent (or Agent) for further delegation and Message to coordinate with main or other agents. Never use read-only Explore/Review agents. Message action=list lists IDs, send delivers a message, read checks your inbox, and wait collects subagent reports. Check your inbox between work steps.\n\n${request.prompt}`
    const turn: Turn = { ...this.turn, text: prompt, attachments: [], permissionMode: 'full', ultra: false, signal: request.signal }
    worker.job = (async () => {
      try {
        await this.run(session, turn)
        await this.wait(undefined, id)
        const reports = session.doc.items.filter((item) => item.kind === 'assistant' && !item.parentId)
        worker.report = reports.map((item) => item.kind === 'assistant' ? item.text : '').filter(Boolean).join('\n\n') || '(Finished without a report.)'
        worker.state = request.signal.aborted ? 'error' : 'done'
        this.root.update<ToolItem>(id, { status: worker.state, output: worker.report, endedAt: Date.now(), meta: { ...this.root.item<ToolItem>(id)?.meta, agentType: 'general' } })
      } catch (error) {
        worker.report = errorMessage(error)
        worker.state = 'error'
        this.root.update<ToolItem>(id, { status: 'error', error: worker.report, output: worker.report, endedAt: Date.now() })
      } finally {
        session.flushDeltas()
        const usage = session.chat.usage
        this.root.addUsage(usage.inputTokens, usage.outputTokens, usage.cost, undefined, false)
        disposeCodex(id)
        disposeAcp(id)
        if (!this.closed) {
          // Reports are retained even if the parent has already finished its own model turn.
          this.inboxes.get(caller.agentId)?.push({ from: id, to: caller.agentId, text: worker.report, ts: Date.now() })
          for (const listener of this.listeners.get(caller.agentId) ?? []) listener()
        }
      }
    })()
    return `Started full-access subagent ${id} (${request.description}). It is running in the background. Use Message to communicate or action=wait with to=${id} for its final report.`
  }

  close(): void { this.closed = true; this.listeners.clear(); this.inboxes.clear() }
}

/** Workers never create sidebar chats or overwrite the main chat's status. */
class WorkerSession extends Session {
  override patchChat(patch: Partial<Chat>): void { Object.assign(this.chat, patch) }
}
