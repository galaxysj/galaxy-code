import { accountEnabled, effectiveEffort, findModel, normalizeEffort, resolveModels } from '@shared/catalog'
import {
  ACCOUNT_LABELS,
  ACP_ACCOUNTS,
  SUBSCRIPTION_ACCOUNT,
  type Chat,
  type ChatEvent,
  type Item,
  type NewChatInput,
  type PromptMentions,
  type QueuedMessage,
  type ResolvedModel,
  type SendInput,
  type UiEvent
} from '@shared/types'
import { disposeAcp, runAcp } from '../engines/acp'
import { runClaude } from '../engines/claude'
import { disposeCodex, runCodex } from '../engines/codex'
import { runNative } from '../engines/native'
import { createWorktree, gitInfo, removeWorktree } from '../services/git'
import { browser } from '../services/browser'
import { generateTitle, MissingKeyError } from '../services/openrouter'
import { store } from '../store'
import { errorMessage, isAbortError, newId, oneLine } from '../util'
import { Session, type Turn } from './session'
import { AgentTeam } from './team'

class ChatManager {
  private sessions = new Map<string, Session>()
  private emitChat: (event: ChatEvent) => void = () => {}
  private emitUi: (event: UiEvent) => void = () => {}

  connect(emitChat: (event: ChatEvent) => void, emitUi: (event: UiEvent) => void): void {
    this.emitChat = emitChat
    this.emitUi = emitUi
  }

  private session(chatId: string): Session {
    let session = this.sessions.get(chatId)
    if (!session) {
      const chat = store.chats.get(chatId)
      if (!chat) throw new Error('Chat not found')
      session = new Session(
        chat,
        (event) => this.emitChat(event),
        (event) => this.emitUi(event)
      )
      this.sessions.set(chatId, session)
    }
    return session
  }

  models(): ResolvedModel[] {
    return resolveModels(store.settings)
  }

  create(input: NewChatInput): Chat {
    const now = Date.now()
    const chat: Chat = {
      id: newId('c_'),
      projectId: input.projectId,
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      status: 'idle',
      unread: false,
      modelKey: input.modelKey,
      effort: input.effort,
      ultra: input.ultra,
      fast: input.fast,
      permissionMode: input.permissionMode,
      workspace: input.projectId ? input.workspace : 'local',
      worktree: null,
      usage: { inputTokens: 0, outputTokens: 0, cost: 0, contextTokens: 0 },
      queued: [],
      ...(input.acpConfig ? { acpConfig: { ...input.acpConfig } } : {})
    }
    store.saveChat(chat)
    this.emitChat({ type: 'chat', chat: { ...chat } })
    return chat
  }

  items(chatId: string): Item[] {
    const session = this.session(chatId)
    session.flushDeltas()
    return session.doc.items
  }

  update(chatId: string, patch: Partial<Chat>): Chat {
    const session = this.session(chatId)
    const allowed: Partial<Chat> = {}
    if (patch.title !== undefined) allowed.title = patch.title.trim().slice(0, 120) || session.chat.title
    if (patch.permissionMode !== undefined) allowed.permissionMode = patch.permissionMode
    if (patch.modelKey !== undefined) allowed.modelKey = patch.modelKey
    if (patch.effort !== undefined) allowed.effort = patch.effort
    if (patch.ultra !== undefined) allowed.ultra = patch.ultra
    if (patch.fast !== undefined) allowed.fast = patch.fast
    if (patch.acpConfig !== undefined) allowed.acpConfig = { ...(session.chat.acpConfig ?? {}), ...patch.acpConfig }
    if (patch.modelKey !== undefined && patch.modelKey !== session.chat.modelKey) {
      // Another agent's options mean nothing here.
      allowed.acpConfig = patch.acpConfig ?? {}
      allowed.acpOptions = []
    }
    session.patchChat(allowed)
    return session.chat
  }

  markRead(chatId: string): void {
    const chat = store.chats.get(chatId)
    if (chat?.unread) this.session(chatId).patchChat({ unread: false })
  }

  async remove(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId)
    if (session?.running) await this.stop(chatId)
    disposeCodex(chatId)
    disposeAcp(chatId)
    const chat = store.chats.get(chatId)
    if (chat?.worktree) {
      const project = store.project(chat.projectId)
      if (project) void removeWorktree(project.path, chat.worktree).catch(() => {})
    }
    this.sessions.delete(chatId)
    store.removeChat(chatId)
    this.emitChat({ type: 'chat-removed', chatId })
  }

  async removeProjectChats(projectId: string): Promise<void> {
    for (const chat of [...store.chats.values()]) {
      if (chat.projectId === projectId) await this.remove(chat.id)
    }
  }

  approve(chatId: string, approvalId: string, decision: 'allow' | 'allow-session' | 'deny', note?: string): void {
    this.sessions.get(chatId)?.resolveApproval(approvalId, decision, note)
  }

  answer(chatId: string, itemId: string, answers: Record<string, string> | null): void {
    this.sessions.get(chatId)?.resolveAnswer(itemId, answers)
  }

  unqueue(chatId: string, messageId: string): void {
    const session = this.session(chatId)
    session.patchChat({ queued: session.chat.queued.filter((m) => m.id !== messageId) })
  }

  async stop(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId)
    if (!session?.controller) return
    // Stopping also drops anything waiting behind the current turn.
    if (session.chat.queued.length) session.patchChat({ queued: [] })
    session.controller.abort()
    session.cancelPending()
  }

  async send(input: SendInput): Promise<void> {
    const session = this.session(input.chatId)
    const text = input.text.trim()
    if (!text && input.attachments.length === 0) return
    if (session.running) {
      const queued: QueuedMessage = { id: newId('q_'), text, attachments: input.attachments, mentions: input.mentions }
      session.patchChat({ queued: [...session.chat.queued, queued] })
      return
    }
    void this.runTurn(session, text, input.attachments, input.mentions)
  }

  private async prepareWorktree(session: Session, hint: string): Promise<void> {
    const chat = session.chat
    if (chat.workspace !== 'worktree' || chat.worktree) return
    const project = store.project(chat.projectId)
    if (!project) return
    try {
      const info = await gitInfo(project.path)
      if (!info.isRepo) throw new Error('This project is not a git repository.')
      const worktree = await createWorktree(project.path, hint)
      session.patchChat({ worktree })
      session.notice('info', `Working in a new worktree on branch ${worktree.branch}`)
    } catch (err) {
      session.patchChat({ workspace: 'local' })
      session.notice('error', `Could not create a worktree, working in the project folder instead. ${errorMessage(err)}`)
    }
  }

  private async nameChat(session: Session, text: string): Promise<void> {
    const fallback = oneLine(text, 48) || 'New chat'
    session.patchChat({ title: fallback })
    const title = await generateTitle(text)
    // Leave it alone if the user renamed the chat in the meantime.
    if (title && session.chat.title === fallback) session.patchChat({ title })
  }

  private async runEngine(session: Session, turn: Turn): Promise<void> {
    const subscription = turn.model.subscription
    if (subscription === 'Default') return runNative(session, turn)
    const account = SUBSCRIPTION_ACCOUNT[subscription]
    if (!accountEnabled(store.settings, account)) {
      const where = ACP_ACCOUNTS.includes(account) ? 'Settings → ACP agents' : 'Settings → AI accounts'
      throw new Error(`${ACCOUNT_LABELS[account]} is turned off. Enable it in ${where}.`)
    }
    if (account === 'claude') return runClaude(session, turn)
    if (account === 'codex') return runCodex(session, turn)
    return runAcp(account, session, turn)
  }

  private async runTurn(session: Session, text: string, attachments: SendInput['attachments'], mentions: PromptMentions = { skills: [], files: [], chats: [], browser: false, tools: [] }): Promise<void> {
    const chat = session.chat
    const controller = new AbortController()
    session.controller = controller
    const startedAt = Date.now()
    const isFirst = !session.doc.items.some((item) => item.kind === 'user')

    session.lastUserText = text
    session.add({ kind: 'user', text, attachments })
    session.patchChat({ status: 'running', updatedAt: startedAt, unread: false })
    if (isFirst) void this.nameChat(session, text || attachments[0]?.name || '')

    let failed = false
    try {
      const model = findModel(this.models(), chat.modelKey)
      if (!model) throw new Error('The model for this chat is no longer available. Pick another model.')
      await this.prepareWorktree(session, text || 'chat')
      if (controller.signal.aborted) return

      const ultra = chat.ultra && model.ultraEffort !== null
      const turn: Turn = {
        text,
        attachments,
        mentions,
        model,
        effort: effectiveEffort(model, normalizeEffort(model, chat.effort), ultra),
        ultra,
        fast: chat.fast && model.fastMode,
        permissionMode: chat.permissionMode,
        signal: controller.signal
      }
      session.team = new AgentTeam(session, turn, (worker, workerTurn) => this.runEngine(worker, workerTurn))
      await this.runEngine(session, turn)
      await session.team.wait()
    } catch (err) {
      if (!controller.signal.aborted && !isAbortError(err)) {
        failed = true
        const message = err instanceof MissingKeyError ? err.message : errorMessage(err)
        session.notice('error', message)
      }
    } finally {
      await session.team?.wait()
      browser.finishRun(session.id)
      session.team?.close()
      session.team = null
      const interrupted = controller.signal.aborted
      session.controller = null
      session.cancelPending()
      session.settle(interrupted)
      session.add({ kind: 'turn', durationMs: Date.now() - startedAt, interrupted })
      session.patchChat({ status: failed ? 'error' : 'idle', updatedAt: Date.now(), unread: true })
      store.flushDocs()

      const next = session.chat.queued[0]
      if (next && !interrupted && !failed) {
        session.patchChat({ queued: session.chat.queued.slice(1) })
        void this.runTurn(session, next.text, next.attachments, next.mentions)
      }
    }
  }

  stopAll(): void {
    for (const session of this.sessions.values()) {
      session.controller?.abort()
      session.cancelPending()
    }
  }
}

export const manager = new ChatManager()
