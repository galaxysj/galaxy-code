import { accountEnabled, canUseChatSubscription, effectiveEffort, findModel, normalizeEffort, resolveModels } from '@shared/catalog'
import {
  ACCOUNT_LABELS,
  ACP_ACCOUNTS,
  SUBSCRIPTION_ACCOUNT,
  type AgentMode,
  type Chat,
  type Attachment,
  type ChatEvent,
  type Item,
  type NewChatInput,
  type PromptMentions,
  type QueuedMessage,
  type ResolvedModel,
  type SendInput,
  type UiEvent,
  type UserItem
} from '@shared/types'
import { disposeAcp, runAcp } from '../engines/acp'
import { runClaude } from '../engines/claude'
import { disposeCodex, runCodex } from '../engines/codex'
import { runNative } from '../engines/native'
import { changedFiles, removeCheckpoints, restoreFiles, snapshot } from '../services/checkpoints'
import { createWorktree, gitInfo, removeWorktree } from '../services/git'
import { browser } from '../services/browser'
import { terminals } from '../services/terminal'
import { stopRevertedBackgroundProcesses } from '../tools/shell'
import { generateTitle, MissingKeyError } from '../services/openrouter'
import { store } from '../store'
import { errorMessage, isAbortError, newId, oneLine, truncateMiddle } from '../util'
import { Session, type Turn } from './session'
import type { PendingEvent } from '../tools/events'
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
      // Listeners do not survive a restart.
      if (chat.resumeAfter) session.patchChat({ resumeAfter: null })
      this.sessions.set(chatId, session)
    }
    return session
  }

  models(): ResolvedModel[] {
    return resolveModels(store.settings)
  }

  create(input: NewChatInput): Chat {
    const now = Date.now()
    const parent = input.side && input.parentChatId ? store.chats.get(input.parentChatId) : undefined
    if (input.side && input.parentChatId && !parent) throw new Error('The parent chat no longer exists.')
    // Resolve inheritance here as well as in the renderer so every creation path
    // selects the parent's provider and engine, including Codex, Claude and ACP.
    if (parent) input = {
      ...input,
      projectId: parent.projectId,
      modelKey: parent.modelKey,
      effort: parent.effort,
      fast: parent.fast,
      ultrafast: parent.ultrafast,
      permissionMode: parent.permissionMode,
      acpConfig: parent.acpConfig ? { ...parent.acpConfig } : undefined
    }
    const chat: Chat = {
      id: newId('c_'),
      projectId: input.projectId,
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      status: 'idle',
      unread: false,
      modelKey: input.modelKey,
      initialSubscription: parent?.initialSubscription ?? input.modelKey.split(':', 1)[0],
      effort: input.effort,
      ultra: input.ultra,
      fast: input.fast,
      ultrafast: input.ultrafast === true,
      permissionMode: input.permissionMode,
      workspace: input.projectId ? input.workspace : 'local',
      worktree: null,
      usage: { inputTokens: 0, outputTokens: 0, cost: 0, contextTokens: 0 },
      queued: [],
      ...(input.acpConfig ? { acpConfig: { ...input.acpConfig } } : {}),
      ...(input.side ? { side: true, workspace: 'local' as const, ...(parent ? { parentChatId: parent.id, worktree: parent.worktree } : {}) } : {})
    }
    store.saveChat(chat)
    if (parent) this.cloneInto(chat, parent)
    this.emitChat({ type: 'chat', chat: { ...chat } })
    return chat
  }

  /**
   * Starts a side chat as a temporary copy of its main chat: the same timeline and, where the
   * engine allows, the agent's own session, so it continues with the full context.
   */
  private cloneInto(chat: Chat, parent: Chat): void {
    const source = this.session(parent.id)
    source.flushDeltas()
    const items = structuredClone(source.doc.items).map((item): Item => {
      if (item.kind === 'user') return { ...item, revertible: false }
      if ((item.kind === 'assistant' || item.kind === 'reasoning') && item.streaming) return { ...item, streaming: false }
      if (item.kind === 'tool' && (item.status === 'running' || item.status === 'pending' || item.status === 'awaiting')) {
        return { ...item, status: 'error', error: 'Still running in the main chat', approval: undefined }
      }
      return item
    })
    const doc = store.doc(chat.id)
    doc.items.push(...items, { kind: 'notice', level: 'info', text: `Side chat copied from "${parent.title}". What happens here does not change the main chat.`, id: newId('i_'), ts: Date.now() })
    chat.sideContextItemCount = doc.items.length
    store.saveChat(chat)
    const engine = source.doc.engine
    const sameModel = parent.modelKey === chat.modelKey
    // The agent picks up from the copy. Engines whose session cannot be copied get the transcript on the first turn.
    if (sameModel && engine.history?.length) doc.engine.history = structuredClone(engine.history)
    if (sameModel && engine.claudeSessionId) Object.assign(doc.engine, { claudeSessionId: engine.claudeSessionId, forkClaude: true })
    doc.engine.parentSeen = doc.engine.history || doc.engine.claudeSessionId ? source.doc.items.length : 0
    if (engine.sessionAllow) doc.engine.sessionAllow = [...engine.sessionAllow]
    store.touchDoc(chat.id)
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
    if (patch.modelKey !== undefined) {
      if (!canUseChatSubscription(session.chat, patch.modelKey.split(':', 1)[0])) {
        throw new Error('This chat cannot switch to that provider. Start a new chat to use it.')
      }
      allowed.modelKey = patch.modelKey
    }
    if (patch.effort !== undefined) allowed.effort = patch.effort
    if (patch.ultra !== undefined) allowed.ultra = patch.ultra
    if (patch.fast !== undefined) allowed.fast = patch.fast
    if (patch.ultrafast !== undefined) allowed.ultrafast = patch.ultrafast
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
    // A deleted chat takes its subagents with it, including those of the run just stopped.
    session?.team?.abort()
    if (session) this.stopListening(session)
    disposeCodex(chatId)
    disposeAcp(chatId)
    const chat = store.chats.get(chatId)
    // A side chat borrows its main chat's worktree.
    if (chat?.worktree && !chat.side) {
      const project = store.project(chat.projectId)
      if (project) void removeWorktree(project.path, chat.worktree).catch(() => {})
    }
    this.sessions.delete(chatId)
    void removeCheckpoints(chatId).catch(() => {})
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
    // Stopping a run stops the main agent only: subagents keep running and their events stay set.
    // With no run in flight, it cancels the events and the subagents.
    if (session && !session.controller) this.stopListening(session)
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
    // A new message starts from the reverted point; the undone turns can no longer be redone.
    if (session.chat.reverted || session.doc.engine.undone) {
      delete session.doc.engine.undone
      session.patchChat({ reverted: null })
    }
    if (session.running) {
      const queued: QueuedMessage = { id: newId('q_'), text, attachments: input.attachments, mentions: input.mentions, steer: input.steer === true, ...(input.mode ? { mode: input.mode } : {}), ...(input.plan ? { plan: input.plan } : {}) }
      session.patchChat({ queued: input.steer ? [queued, ...session.chat.queued] : [...session.chat.queued, queued] })
      if (input.steer) {
        session.controller?.abort()
        session.cancelPending()
      }
      return
    }
    void this.runTurn(session, text, input.attachments, input.mentions, { mode: input.mode, plan: input.plan })
  }

  /** Snapshot of the chat's folder, or null when it cannot be taken. */
  private async checkpoint(session: Session): Promise<string | null> {
    try {
      return await snapshot(session.id, await session.cwd())
    } catch {
      return null
    }
  }

  /**
   * Puts files and the timeline back to just before a user message. Every later turn's
   * edits go too. Fails without changing anything when a file it would restore was
   * changed by someone else since the chat's last turn. `messageOnly` leaves the files
   * alone and only takes the turns out of the timeline. Returns why the files could not be restored, without throwing,
   * so the renderer can offer a message-only revert; null when it reverted.
   */
  async revert(chatId: string, itemId: string, messageOnly = false): Promise<string | null> {
    const session = this.session(chatId)
    if (session.running) throw new Error('Stop the chat before reverting.')
    const items = session.doc.items
    const index = items.findIndex((item) => item.id === itemId && item.kind === 'user' && !item.parentId)
    if (index < 0) throw new Error('That message is no longer in this chat.')
    const message = items[index] as UserItem
    const checkpoints = session.doc.engine.checkpoints ?? {}
    const later = items.slice(index).filter((item): item is UserItem => item.kind === 'user' && !item.parentId)
    let target = ''
    let source = ''
    let files: string[] = []
    if (!messageOnly) {
      if (!checkpoints[message.id]?.before || later.some((item) => !checkpoints[item.id]?.after)) {
        return 'This message was sent before checkpoints were recorded, so its changes cannot be reverted.'
      }
      target = checkpoints[message.id]!.before
      source = checkpoints[later[later.length - 1].id].after!
      const now = await snapshot(chatId, await session.cwd())
      if (!now) return 'This folder has too many files to revert safely.'
      files = await changedFiles(chatId, target, source)
      const touched = new Set(await changedFiles(chatId, source, now))
      const conflicts = files.filter((path) => touched.has(path))
      if (conflicts.length) return conflictMessage('revert', conflicts)
    }
    const revertedItemIds = new Set(items.slice(index).map((item) => item.id))
    await terminals.stopReverted(chatId, revertedItemIds)
    stopRevertedBackgroundProcesses(chatId, revertedItemIds)
    if (files.length) await restoreFiles(chatId, await session.cwd(), target, files)

    const { undone: _undone, ...engine } = session.doc.engine
    session.doc.engine.undone = { items: items.slice(index), engine: structuredClone(engine), files, target, source }
    for (const item of later) delete checkpoints[item.id]
    session.replaceItems(items.slice(0, index))
    // The agent's own session still remembers the removed turns, so start it afresh.
    Object.assign(session.doc.engine, { history: undefined, claudeSessionId: undefined, codexThreadId: undefined, acpSessionId: undefined, parentSeen: undefined, replay: true })
    disposeCodex(chatId)
    disposeAcp(chatId)
    session.patchChat({ reverted: { text: message.text, attachments: message.attachments, ...(message.prompt ? { mentions: message.prompt } : {}) } })
    store.flushDocs()
    return null
  }

  /** Undoes the last revert while nothing new has been sent. */
  async redo(chatId: string): Promise<void> {
    const session = this.session(chatId)
    if (session.running) throw new Error('Stop the chat before redoing.')
    const undone = session.doc.engine.undone
    if (!undone) throw new Error('There is nothing to redo.')
    // A message-only revert left the files alone, so there is nothing to put back.
    if (undone.files.length) {
      const root = await session.cwd()
      const now = await snapshot(chatId, root)
      if (!now) throw new Error('This folder has too many files to redo safely.')
      const touched = new Set(await changedFiles(chatId, undone.target, now))
      const conflicts = undone.files.filter((path) => touched.has(path))
      if (conflicts.length) throw new Error(conflictMessage('redo', conflicts))
      await restoreFiles(chatId, root, undone.source, undone.files)
    }
    const checkpoints = session.doc.engine.checkpoints ?? {}
    session.doc.engine = { ...undone.engine, checkpoints: { ...(undone.engine.checkpoints ?? {}), ...checkpoints } }
    session.replaceItems([...session.doc.items, ...undone.items])
    disposeCodex(chatId)
    disposeAcp(chatId)
    session.patchChat({ reverted: null })
    store.flushDocs()
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

  /**
   * After a turn that set events: shows "Will resume after …" and listens. Each event resumes
   * the agent once when it fires, and the others stay set, also while the user sends new messages.
   */
  /** `mode` is the composer mode of the turn that set the events; the resumed turn keeps it. */
  private listen(session: Session, events: PendingEvent[], mode?: AgentMode): void {
    for (const event of events) {
      let done = false
      let stop = (): void => {}
      const entry = {
        label: event.label,
        cancel: () => {
          if (done) return
          done = true
          stop()
          session.listening.delete(entry)
          this.showListening(session)
        }
      }
      session.listening.add(entry)
      stop = event.start((detail) => {
        if (done) return
        entry.cancel()
        this.resume(session, `The event you set fired: ${event.label}.\n\n${detail}\n\nContinue the task.`, event.label, mode)
      })
      if (done) stop()
    }
    this.showListening(session)
  }

  private showListening(session: Session): void {
    // Only the most recently set event is shown.
    const resumeAfter = [...session.listening].at(-1)?.label ?? null
    if (session.chat.resumeAfter !== resumeAfter) session.patchChat({ resumeAfter })
  }

  /** Resumes the agent now, or after the turn in flight. */
  private resume(session: Session, text: string, label: string, mode?: AgentMode): void {
    if (session.running) session.pendingResumes.push({ text, label, mode })
    else void this.runTurn(session, text, [], undefined, { event: label, mode })
  }

  /** Cancels every event, and aborts subagents still running from earlier turns. */
  private stopListening(session: Session): void {
    for (const entry of [...session.listening]) entry.cancel()
    for (const team of session.background) team.abort()
    session.background.clear()
    session.pendingResumes = []
  }

  private async runTurn(session: Session, text: string, attachments: SendInput['attachments'], mentions: PromptMentions = { skills: [], files: [], chats: [], browser: false, tools: [] }, extra: { mode?: AgentMode; plan?: string; event?: string } = {}): Promise<void> {
    const chat = session.chat
    // Ask and Plan are only enforced by Galaxy Code's own tools.
    const mode = extra.mode && findModel(this.models(), chat.modelKey)?.subscription === 'Default' ? extra.mode : undefined
    const controller = new AbortController()
    session.controller = controller
    const startedAt = Date.now()
    const isFirst = !session.doc.items.some((item) => item.kind === 'user')

    session.lastUserText = text
    session.events = []
    // A turn an event resumed still runs in its mode, but its message shows no mode label.
    const userItem = session.add<UserItem>({ kind: 'user', text, ...(extra.event ? { event: extra.event } : {}), attachments, prompt: mentions, ...(mentions.chips?.length ? { mentions: mentions.chips } : {}), ...(mode && !extra.event ? { mode } : {}), ...(extra.plan ? { plan: extra.plan } : {}) })
    // Earlier conversation for an agent whose session was reset by a revert.
    const replay = session.doc.engine.replay ? replayTranscript(session.doc.items.slice(0, -1)) : ''
    const parent = this.parentContext(session)
    // The main chat's attachments go along as real attachments, so images can be seen too.
    const shared = parent.attachments.filter((file) => !attachments.some((own) => own.path === file.path))
    session.patchChat({ status: 'running', updatedAt: startedAt, unread: false })
    if (isFirst) void this.nameChat(session, text || attachments[0]?.name || '')

    let failed = false
    try {
      const model = findModel(this.models(), chat.modelKey)
      if (!model) throw new Error('The model for this chat is no longer available. Pick another model.')
      await this.prepareWorktree(session, text || 'chat')
      if (controller.signal.aborted) return
      const before = await this.checkpoint(session)
      if (before) {
        session.doc.engine.checkpoints = { ...session.doc.engine.checkpoints, [userItem.id]: { before } }
        session.update<UserItem>(userItem.id, { revertible: true })
      }

      // Multitask runs its own subagents and cannot be combined with Ultra.
      const ultra = chat.ultra && model.ultraEffort !== null && mode !== 'multitask'
      delete session.doc.engine.replay
      const turn: Turn = {
        text: [parent.text, replay, text].filter(Boolean).join('\n\n'),
        attachments: [...shared, ...attachments],
        mentions,
        model,
        effort: effectiveEffort(model, normalizeEffort(model, chat.effort), ultra),
        ultra,
        fast: chat.fast && model.fastMode,
        ultrafast: chat.fast && chat.ultrafast === true && model.ultrafastMode,
        permissionMode: chat.permissionMode,
        mode,
        signal: controller.signal
      }
      session.team = new AgentTeam(session, turn, (worker, workerTurn) => this.runEngine(worker, workerTurn))
      await this.runEngine(session, turn)
      // Subagents an event waits for may outlive the turn, and so do they when the turn is stopped.
      if (!session.events.some((event) => event.keepsTeam)) await Promise.race([session.team.wait(), new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true }))])
    } catch (err) {
      if (!controller.signal.aborted && !isAbortError(err)) {
        failed = true
        const message = err instanceof MissingKeyError ? err.message : errorMessage(err)
        session.notice('error', message)
      }
    } finally {
      // Events stay set when the turn is stopped, since the subagents they wait for keep running.
      const events = failed ? [] : session.events
      session.events = []
      const team = session.team
      const background = !!team && team.hasRunning() && (controller.signal.aborted || events.some((event) => event.keepsTeam))
      if (!background) await team?.wait()
      browser.finishRun(session.id)
      if (background) {
        session.background.add(team!)
        void team!.wait().then(() => { session.background.delete(team!); team!.close() })
      }
      else team?.close()
      session.team = null
      const interrupted = controller.signal.aborted
      session.cancelPending()
      // Subagents still running keep their items live, including those an earlier turn left in the background.
      const running = new Set([...session.background].flatMap((entry) => [...entry.runningIds()]))
      session.settle(interrupted, (item) => running.has(item.id) || !!item.parentId && running.has(item.parentId))
      const mark = session.doc.engine.checkpoints?.[userItem.id]
      if (mark) {
        const after = await this.checkpoint(session)
        if (after) mark.after = after
        else delete session.doc.engine.checkpoints![userItem.id]
      }
      session.add({ kind: 'turn', durationMs: Date.now() - startedAt, interrupted })
      session.controller = null
      session.patchChat({ status: failed ? 'error' : 'idle', updatedAt: Date.now(), unread: true })
      store.flushDocs()

      if (events.length) this.listen(session, events, mode)
      const next = session.chat.queued[0]
      const resume = interrupted ? undefined : session.pendingResumes.shift()
      if (next && (next.steer || (!interrupted && !failed))) {
        session.patchChat({ queued: session.chat.queued.slice(1) })
        if (resume) session.pendingResumes.unshift(resume)
        void this.runTurn(session, next.text, next.attachments, next.mentions, { mode: next.mode, plan: next.plan })
      } else if (resume) {
        void this.runTurn(session, resume.text, [], undefined, { event: resume.label, mode: resume.mode })
      }
    }
  }

  /**
   * For a side chat, the parent chat's conversation the agent has not seen yet: all of it on the
   * first turn, then only what was said there since. Marks it seen.
   */
  private parentContext(session: Session): { text: string; attachments: Attachment[] } {
    const parentId = session.chat.parentChatId
    if (!parentId || !store.chats.has(parentId)) return { text: '', attachments: [] }
    const items = this.items(parentId)
    const seen = session.doc.engine.parentSeen ?? 0
    const start = seen <= items.length ? seen : 0
    session.doc.engine.parentSeen = items.length
    const fresh = items.slice(start)
    const attachments = fresh.flatMap((item) => (item.kind === 'user' ? item.attachments : []))
    const lines = parentTranscript(fresh)
    if (!lines) return { text: '', attachments }
    const title = store.chats.get(parentId)?.title ?? 'the main chat'
    const text = start === 0
      ? `<main_chat title="${title.replace(/"/g, "'")}">\nThis is a side chat opened from the user's main chat. You share its context: below is that conversation so far, with its tool calls, file changes and attachments, for reference. Answer and work in this side chat; the main chat's agent may still be working in the same folder, so re-read files before editing them.\n\n${lines}\n</main_chat>`
      : `<main_chat_update>\nNew in the main chat since your last message:\n\n${lines}\n</main_chat_update>`
    return { text, attachments }
  }

  stopAll(): void {
    for (const session of this.sessions.values()) {
      session.controller?.abort()
      session.cancelPending()
    }
  }
}

function conflictMessage(action: 'revert' | 'redo', paths: string[]): string {
  const list = paths.slice(0, 8).join('\n')
  const more = paths.length > 8 ? `\n…and ${paths.length - 8} more` : ''
  return `Cannot ${action}: these files were changed outside this chat since then.\n\n${list}${more}\n\nUndo or commit those changes first${action === 'revert' ? ', or revert the message only' : ''}.`
}

/** The visible conversation, for an agent starting over after a revert. */
function transcriptLines(items: Item[]): string {
  return items
    .flatMap((item) => (item.kind === 'user' || item.kind === 'assistant') && !item.parentId && item.text.trim() ? [`${item.kind === 'user' ? 'User' : 'Assistant'}: ${item.text.trim()}`] : [])
    .join('\n\n')
    .slice(-24000)
}

/** The main chat as a side chat sees it: messages, tool calls with their results, file changes and attachments. */
function parentTranscript(items: Item[]): string {
  const blocks: string[] = []
  for (const item of items) {
    const by = item.parentId ? ' (subagent)' : ''
    if (item.kind === 'user' && !item.parentId) {
      const files = item.attachments.map((file) => `- ${file.name} (${file.mime}) at ${file.path}`).join('\n')
      blocks.push(`User: ${item.text.trim()}${files ? `\nAttached files:\n${files}` : ''}`)
    } else if (item.kind === 'assistant' && item.text.trim()) {
      blocks.push(`Assistant${by}: ${item.text.trim()}`)
    } else if (item.kind === 'tool') {
      const lines = [`Tool${by} ${item.name} [${item.status}]: ${item.title}${item.detail ? ` — ${oneLine(item.detail, 300)}` : ''}`]
      if (item.input && typeof item.input === 'object' && Object.keys(item.input).length) lines.push(`Input: ${truncateMiddle(JSON.stringify(item.input), 1500)}`)
      if (item.error) lines.push(`Error: ${item.error}`)
      else if (item.output?.trim()) lines.push(`Result: ${truncateMiddle(item.output.trim(), 2000)}`)
      for (const diff of item.meta?.diffs ?? []) {
        const change = diff.created ? 'created' : diff.deleted ? 'deleted' : 'changed'
        lines.push(`File ${change}: ${diff.path} (+${diff.added} -${diff.removed})${diff.patch ? `\n${truncateMiddle(diff.patch, 4000)}` : ''}`)
      }
      blocks.push(lines.join('\n'))
    }
  }
  const text = blocks.join('\n\n')
  return text.length > 80_000 ? `[Earlier part of the main chat omitted]\n\n${text.slice(-80_000)}` : text
}

function replayTranscript(items: Item[]): string {
  const lines = transcriptLines(items)
  return lines ? `<earlier_conversation>\nThe user reverted later messages. This is the conversation up to this point:\n\n${lines}\n</earlier_conversation>` : ''
}

export const manager = new ChatManager()
