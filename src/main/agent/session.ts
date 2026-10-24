import { app } from 'electron'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AgentMode,
  ApprovalRequest,
  AskQuestion,
  Attachment,
  Chat,
  ChatEvent,
  ChatStatus,
  Effort,
  Item,
  PermissionMode,
  PromptMentions,
  ResolvedModel,
  ToolItem,
  UiEvent
} from '@shared/types'
import { recordUsage } from '../services/analytics'
import { store, type ChatDoc } from '../store'
import { newId } from '../util'
import type { PendingEvent } from '../tools/events'
import type { AgentTeam } from './team'

export interface Turn {
  text: string
  attachments: Attachment[]
  mentions: PromptMentions
  model: ResolvedModel
  /** Effort the request runs at, already resolved for Ultra. */
  effort: Effort | null
  ultra: boolean
  fast: boolean
  /** Ultrafast tier. Only set when fast is. */
  ultrafast: boolean
  permissionMode: PermissionMode
  /** Ask or Plan keeps the turn read-only. Native engine only. */
  mode?: AgentMode
  signal: AbortSignal
}

export type ApprovalDecision = { allowed: true; forSession: boolean } | { allowed: false; note?: string }

/** An item before it is stamped with an id and time. Distributes over the Item union. */
export type NewItem<T extends Item> = T extends Item ? Omit<T, 'id' | 'ts'> & { id?: string; ts?: number } : never

type Emit = (event: ChatEvent) => void
type EmitUi = (event: UiEvent) => void

/** Live state of one chat: its timeline, pending prompts, and the run in flight. */
export class Session {
  team: AgentTeam | null = null
  /** Triggers set by the Event tool this turn. The chat listens for them once the turn ends. */
  events: PendingEvent[] = []
  /** Stops listening for events, when the chat is. */
  stopListening: ((abortWork: boolean) => void) | null = null
  agentId = 'main'
  readonly doc: ChatDoc
  controller: AbortController | null = null
  private approvals = new Map<string, { itemId: string; resolve: (decision: ApprovalDecision) => void }>()
  private answers = new Map<string, (answers: Record<string, string> | null) => void>()
  private deltaBuffer = new Map<string, { itemId: string; field: 'text' | 'output'; delta: string; offset: number }>()
  private deltaTimer: NodeJS.Timeout | null = null
  private scratchDir: string | null = null
  private persistent: boolean
  lastUserText = ''

  constructor(
    public chat: Chat,
    private emit: Emit,
    readonly emitUi: EmitUi,
    doc?: ChatDoc
  ) {
    this.doc = doc ?? store.doc(chat.id)
    this.persistent = doc === undefined
  }

  get id(): string {
    return this.chat.id
  }

  get running(): boolean {
    return this.controller !== null
  }

  get projectPath(): string | null {
    return store.project(this.chat.projectId)?.path ?? null
  }

  /** Directory tools and CLIs run in. */
  async cwd(): Promise<string> {
    if (this.chat.worktree) return this.chat.worktree.path
    const project = this.projectPath
    if (project) return project
    if (!this.scratchDir) {
      this.scratchDir = join(app.getPath('documents'), 'Galaxy', 'Chats', this.chat.id.slice(0, 8))
      await mkdir(this.scratchDir, { recursive: true })
    }
    return this.scratchDir
  }

  // Chat metadata

  patchChat(patch: Partial<Chat>): void {
    Object.assign(this.chat, patch)
    store.saveChat(this.chat)
    this.emit({ type: 'chat', chat: { ...this.chat } })
  }

  setStatus(status: ChatStatus): void {
    if (this.chat.status !== status) this.patchChat({ status })
  }

  /** `record` is off when re-adding a worker's totals that were already recorded under its own model. */
  addUsage(input: number, output: number, cost: number, context?: number, record = true): void {
    const usage = this.chat.usage
    if (record) recordUsage(this.chat.modelKey, input, output, cost)
    this.patchChat({
      usage: {
        inputTokens: usage.inputTokens + input,
        outputTokens: usage.outputTokens + output,
        cost: usage.cost + cost,
        contextTokens: context ?? usage.contextTokens
      }
    })
  }

  // Timeline

  item<T extends Item = Item>(id: string): T | undefined {
    return this.doc.items.find((i) => i.id === id) as T | undefined
  }

  add<T extends Item = Item>(item: NewItem<T>): T {
    const full = { ...item, id: item.id ?? newId('i_'), ts: item.ts ?? Date.now() } as unknown as T
    this.doc.items.push(full)
    if (this.persistent) store.touchDoc(this.id)
    this.emit({ type: 'item', chatId: this.id, item: full })
    return full
  }

  update<T extends Item>(id: string, patch: Partial<T>): T | undefined {
    const item = this.item<T>(id)
    if (!item) return undefined
    this.flushDeltas()
    Object.assign(item, patch)
    if (this.persistent) store.touchDoc(this.id)
    this.emit({ type: 'item', chatId: this.id, item: { ...item } })
    return item
  }

  /** Swaps the whole timeline, as a revert or redo does. */
  replaceItems(items: Item[]): void {
    this.flushDeltas()
    this.doc.items.splice(0, this.doc.items.length, ...items)
    if (this.persistent) store.touchDoc(this.id)
    this.emit({ type: 'items-reset', chatId: this.id, items: [...this.doc.items] })
  }

  /** Appends streamed text. Deltas are coalesced so the renderer is not flooded. */
  append(id: string, field: 'text' | 'output', delta: string): void {
    if (!delta) return
    const item = this.item(id)
    if (!item) return
    const record = item as unknown as Record<string, string | undefined>
    const previous = record[field] ?? ''
    const next = previous + delta
    // Long-running commands can print without bound.
    if (field === 'output' && next.length > 200_000) {
      this.update<ToolItem>(id, { output: next.slice(-150_000) })
      return
    }
    record[field] = next
    if (this.persistent) store.touchDoc(this.id)

    const key = `${id}:${field}`
    const pending = this.deltaBuffer.get(key)
    if (pending) pending.delta += delta
    else this.deltaBuffer.set(key, { itemId: id, field, delta, offset: previous.length })
    if (!this.deltaTimer) this.deltaTimer = setTimeout(() => this.flushDeltas(), 32)
  }

  flushDeltas(): void {
    if (this.deltaTimer) {
      clearTimeout(this.deltaTimer)
      this.deltaTimer = null
    }
    for (const entry of this.deltaBuffer.values()) {
      this.emit({ type: 'delta', chatId: this.id, ...entry })
    }
    this.deltaBuffer.clear()
  }

  notice(level: 'info' | 'error', text: string, parentId?: string): void {
    this.add({ kind: 'notice', level, text, parentId })
  }

  // Approvals and questions

  requestApproval(itemId: string, request: Omit<ApprovalRequest, 'id'>): Promise<ApprovalDecision> {
    const approval: ApprovalRequest = { ...request, id: newId('a_') }
    this.update<ToolItem>(itemId, { status: 'awaiting', approval })
    this.setStatus('awaiting')
    return new Promise((resolve) => {
      this.approvals.set(approval.id, {
        itemId,
        resolve: (decision) => {
          this.approvals.delete(approval.id)
          const item = this.item<ToolItem>(itemId)
          if (item) {
            delete item.approval
            this.update<ToolItem>(itemId, { status: decision.allowed ? 'running' : 'denied' })
          }
          if (this.running && this.approvals.size === 0 && this.answers.size === 0) this.setStatus('running')
          resolve(decision)
        }
      })
    })
  }

  resolveApproval(approvalId: string, decision: 'allow' | 'allow-session' | 'deny', note?: string): void {
    const pending = this.approvals.get(approvalId)
    if (!pending) return
    const item = this.item<ToolItem>(pending.itemId)
    if (decision === 'allow-session' && item?.approval?.sessionKey) {
      const allow = new Set(this.doc.engine.sessionAllow ?? [])
      allow.add(item.approval.sessionKey)
      this.doc.engine.sessionAllow = [...allow]
      if (this.persistent) store.touchDoc(this.id)
    }
    pending.resolve(decision === 'deny' ? { allowed: false, note } : { allowed: true, forSession: decision === 'allow-session' })
  }

  isSessionAllowed(key: string | undefined): boolean {
    return !!key && (this.doc.engine.sessionAllow ?? []).includes(key)
  }

  /** Shows questions on an Ask item and waits. Resolves null if the user dismisses or the run stops. */
  ask(itemId: string, questions: AskQuestion[]): Promise<Record<string, string> | null> {
    const item = this.item<ToolItem>(itemId)
    this.update<ToolItem>(itemId, { status: 'awaiting', meta: { ...(item?.meta ?? {}), questions } })
    this.setStatus('awaiting')
    return new Promise((resolve) => {
      this.answers.set(itemId, (answers) => {
        this.answers.delete(itemId)
        if (this.running && this.approvals.size === 0 && this.answers.size === 0) this.setStatus('running')
        resolve(answers)
      })
    })
  }

  resolveAnswer(itemId: string, answers: Record<string, string> | null): void {
    this.answers.get(itemId)?.(answers)
  }

  /** Releases everything waiting on the user, used when a run is stopped. */
  cancelPending(): void {
    for (const pending of [...this.approvals.values()]) pending.resolve({ allowed: false, note: 'Stopped by user' })
    for (const resolve of [...this.answers.values()]) resolve(null)
  }

  /** Marks anything still live as finished so the UI stops spinning. */
  /** Ends everything still streaming or running, except what `keep` holds, such as subagents left running in the background. */
  settle(interrupted: boolean, keep?: (item: Item) => boolean): void {
    this.flushDeltas()
    for (const item of this.doc.items) {
      if (keep?.(item)) continue
      if ((item.kind === 'assistant' || item.kind === 'reasoning') && item.streaming) {
        this.update(item.id, { streaming: false, ...(item.kind === 'reasoning' ? { endedAt: Date.now() } : {}) })
      } else if (item.kind === 'tool' && (item.status === 'running' || item.status === 'pending' || item.status === 'awaiting')) {
        this.update<ToolItem>(item.id, {
          status: 'error',
          error: interrupted ? 'Stopped' : 'Did not finish',
          endedAt: Date.now(),
          approval: undefined
        })
      }
    }
  }
}

/**
 * Writes streamed assistant output into the timeline, keeping text and
 * reasoning as separate blocks in the order they arrive.
 */
export class TurnWriter {
  private textId: string | null = null
  private reasoningId: string | null = null

  constructor(
    private session: Session,
    private parentId?: string
  ) {}

  text(delta: string): void {
    if (!delta) return
    this.endReasoning()
    if (!this.textId) {
      this.textId = this.session.add({ kind: 'assistant', text: '', streaming: true, parentId: this.parentId }).id
    }
    this.session.append(this.textId, 'text', delta)
  }

  reasoning(delta: string): void {
    if (!delta) return
    this.endText()
    if (!this.reasoningId) {
      this.reasoningId = this.session.add({ kind: 'reasoning', text: '', streaming: true, parentId: this.parentId }).id
    }
    this.session.append(this.reasoningId, 'text', delta)
  }

  /** Replaces the current text block wholesale, for providers that resend full text. */
  setText(text: string): void {
    this.endReasoning()
    if (!this.textId) {
      this.textId = this.session.add({ kind: 'assistant', text, streaming: true, parentId: this.parentId }).id
    } else {
      this.session.update(this.textId, { text })
    }
  }

  get currentText(): string {
    return this.textId ? ((this.session.item(this.textId) as { text?: string } | undefined)?.text ?? '') : ''
  }

  endText(): void {
    if (!this.textId) return
    this.session.update(this.textId, { streaming: false })
    this.textId = null
  }

  endReasoning(): void {
    if (!this.reasoningId) return
    this.session.update(this.reasoningId, { streaming: false, endedAt: Date.now() })
    this.reasoningId = null
  }

  end(): void {
    this.endText()
    this.endReasoning()
  }
}
