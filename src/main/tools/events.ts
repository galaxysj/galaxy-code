import { terminals } from '../services/terminal'
import { hasShell, shellInfo, watchShell } from './shell'
import { sleep } from '../util'
import { num, str, ToolInputError, type ToolDef } from './types'

/**
 * A trigger the Event tool sets. Nothing happens until the agent's turn ends; then the
 * chat listens, and the first trigger to fire resumes the agent with its result.
 */
export interface PendingEvent {
  /** Completes "Will resume after …". */
  label: string
  /** Subagents this event waits for keep running after the turn ends. */
  keepsTeam?: boolean
  /** The Event call that set it, so reverting that turn can drop it. */
  itemId?: string
  /** Starts listening; calls fire once with what happened. Returns a function that stops listening. */
  start(fire: (detail: string) => void): () => void
}

const TRIGGERS = ['subagent-finish', 'terminal-finish', 'timer'] as const

/** One target or a list of them. */
function targets(input: Record<string, unknown>): string[] {
  const value = input.target
  const list = (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
  if (!list.length) throw new ToolInputError('target is required')
  return [...new Set(list)]
}

export const eventTool: ToolDef = {
  name: 'Event',
  kind: 'event',
  description: `Set a trigger that resumes you later, so you can end your reply instead of polling. It takes effect when you finish your reply: the chat then waits, and when the trigger fires you are resumed with what happened. Use it for work that outlives your turn.

Triggers:
- subagent-finish: a subagent you started with Agent finishes (target = its ID, or a list of IDs to resume when any of them finishes). Its report comes back to you. Subagents you wait for this way keep running after your reply.
- terminal-finish: a command finishes. The target is a terminal tabId, or the shell ID of a background command you started with Bash run_in_background, such as shell-3; a list resumes you when any of them finishes. It fires when the process exits or its output has been quiet for quiet_seconds. The end of its output comes back to you.
- timer: a set number of seconds passes.

Each Event resumes you once when it fires; other Events you set stay set, also while the user sends new messages. Stopping the chat cancels them. In your reply, tell the user what you are waiting for.`,
  parameters: {
    type: 'object',
    properties: {
      trigger: { type: 'string', enum: [...TRIGGERS] },
      target: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Subagent ID for subagent-finish. For terminal-finish, a terminal tabId, or the ID of a background command started with Bash run_in_background, such as shell-3. A list resumes you when any of them finishes.' },
      seconds: { type: 'number', description: 'For timer: how long to wait. For the other triggers: give up and resume after this many seconds. Defaults to 1800 for those.' },
      quiet_seconds: { type: 'number', description: 'For terminal-finish: how long the output must stay quiet. Defaults to 5.' }
    },
    required: ['trigger']
  },
  present(input) {
    return { title: `Event ${String(input.trigger ?? '')}` }
  },
  async execute(input, ctx) {
    if (ctx.session.agentId !== 'main') throw new ToolInputError('Only the main agent can set events. Use Message to report back instead.')
    const trigger = str(input, 'trigger', true) as (typeof TRIGGERS)[number]
    if (!TRIGGERS.includes(trigger)) throw new ToolInputError(`trigger must be one of ${TRIGGERS.join(', ')}`)
    const seconds = num(input, 'seconds')
    if (seconds !== undefined && (!(seconds > 0) || seconds > 86400)) throw new ToolInputError('seconds must be between 0 and 86400')
    const timeoutMs = (seconds ?? 1800) * 1000
    // Resumes with the detail, or after the timeout says so.
    const withTimeout = (listen: (fire: (detail: string) => void) => () => void) => (fire: (detail: string) => void): (() => void) => {
      const timer = setTimeout(() => fire(`It did not happen within ${timeoutMs / 1000} seconds.`), timeoutMs)
      const stop = listen(fire)
      return () => { clearTimeout(timer); stop() }
    }

    let event: PendingEvent
    if (trigger === 'timer') {
      if (seconds === undefined) throw new ToolInputError('timer needs seconds')
      event = {
        label: `${seconds} seconds`,
        start(fire) {
          const timer = setTimeout(() => fire(`${seconds} seconds have passed.`), timeoutMs)
          return () => clearTimeout(timer)
        }
      }
    } else if (trigger === 'subagent-finish') {
      const team = ctx.session.team
      const ids = targets(input)
      for (const target of ids) if (!team?.has(target)) throw new ToolInputError(`No subagent with ID ${target}. Use Message action=list to find IDs.`)
      event = {
        // Only the last target is shown.
        label: `${team!.name(ids.at(-1)!)} finishes`,
        keepsTeam: true,
        start: withTimeout((fire) => {
          let stopped = false
          for (const target of ids) void team!.wait(target).then((report) => { if (!stopped) fire(`Subagent ${target} (${team!.name(target)}) finished. Its report:\n\n${report}`) })
          return () => { stopped = true }
        })
      }
    } else {
      const ids = targets(input)
      const quietMs = (num(input, 'quiet_seconds') ?? 5) * 1000
      for (const target of ids) if (!terminals.list().some((tab) => tab.tabId === target) && !hasShell(target)) throw new ToolInputError(`No open terminal with tabId ${target} and no background command with that shell ID. Terminal tabIds come from the user's terminal tabs; shell IDs, such as shell-3, come from Bash run_in_background.`)
      const watch = (target: string, fire: (detail: string) => void): (() => void) => {
        if (hasShell(target)) {
          const info = (): NonNullable<ReturnType<typeof shellInfo>> => shellInfo(target) ?? { name: target, tail: '', exited: true, code: null }
          const name = (): string => ids.length > 1 ? `Command ${target}` : `The command "${info().name}"`
          const report = (): string => info().tail
          let quiet = setTimeout(() => fire(`${name()} output has been quiet for ${quietMs / 1000} seconds. Its end:\n\n${report()}`), quietMs)
          const stop = watchShell(target, (exited) => {
            clearTimeout(quiet)
            if (exited) fire(`${name()} exited with code ${info().code}. The end of its output:\n\n${report()}`)
            else quiet = setTimeout(() => fire(`${name()} output has been quiet for ${quietMs / 1000} seconds. Its end:\n\n${report()}`), quietMs)
          })
          return () => { clearTimeout(quiet); stop() }
        }
        const tail = (): string => terminals.read(target).slice(-4000)
        const name = ids.length > 1 ? `Terminal ${target}` : 'The terminal'
        let quiet = setTimeout(() => fire(`${name} output has been quiet for ${quietMs / 1000} seconds. Its end:\n\n${tail()}`), quietMs)
        const stop = terminals.watch(target, (exited) => {
          clearTimeout(quiet)
          if (exited) fire(`${name} process exited. The end of its output:\n\n${tail()}`)
          else quiet = setTimeout(() => fire(`${name} output has been quiet for ${quietMs / 1000} seconds. Its end:\n\n${tail()}`), quietMs)
        })
        return () => { clearTimeout(quiet); stop() }
      }
      event = {
        label: ids.length === 1 && hasShell(ids[0]) ? `${shellInfo(ids[0])!.name} finishes` : 'Terminal finishes',
        start: withTimeout((fire) => {
          let fired = false
          const once = (detail: string): void => { if (!fired) { fired = true; fire(detail) } }
          const stops = ids.map((target) => watch(target, once))
          return () => { for (const stop of stops) stop() }
        })
      }
    }
    event.itemId = ctx.itemId
    ctx.session.events.push(event)
    return { text: `Event set: you will be resumed after ${event.label}. Finish your reply now; listening starts when it ends.` }
  }
}

export const waitTool: ToolDef = {
  name: 'Wait',
  kind: 'wait',
  description: 'Pause for a number of seconds, then continue. Use it for short waits, such as letting a server start before checking it. For long waits, end your reply and use Event instead.',
  parameters: {
    type: 'object',
    properties: { seconds: { type: 'number', description: 'How long to wait, at most 600.' } },
    required: ['seconds']
  },
  present(input) {
    return { title: `Wait ${Number(input.seconds ?? 0)}s` }
  },
  async execute(input, ctx) {
    const seconds = num(input, 'seconds')
    if (seconds === undefined || !(seconds > 0) || seconds > 600) throw new ToolInputError('seconds must be between 0 and 600')
    await sleep(seconds * 1000, ctx.signal)
    return { text: `Waited ${seconds} seconds.` }
  }
}
