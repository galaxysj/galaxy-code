import { terminals } from '../services/terminal'
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
  /** Starts listening; calls fire once with what happened. Returns a function that stops listening. */
  start(fire: (detail: string) => void): () => void
}

const TRIGGERS = ['subagent-finish', 'terminal-finish', 'timer'] as const

export const eventTool: ToolDef = {
  name: 'Event',
  kind: 'event',
  description: `Set a trigger that resumes you later, so you can end your reply instead of polling. It takes effect when you finish your reply: the chat then waits, and when the trigger fires you are resumed with what happened. Use it for work that outlives your turn.

Triggers:
- subagent-finish: a subagent you started with Agent finishes (target = its ID). Its report comes back to you. Subagents you wait for this way keep running after your reply.
- terminal-finish: the command running in a Terminal tab finishes (target = tabId). It fires when the tab's process exits or its output has been quiet for quiet_seconds. The end of its output comes back to you.
- timer: a set number of seconds passes.

If you set several, the first to fire resumes you and the rest are dropped. A new message from the user also cancels them. In your reply, tell the user what you are waiting for.`,
  parameters: {
    type: 'object',
    properties: {
      trigger: { type: 'string', enum: [...TRIGGERS] },
      target: { type: 'string', description: 'Subagent ID for subagent-finish, terminal tabId for terminal-finish.' },
      seconds: { type: 'number', description: 'For timer: how long to wait. For the other triggers: give up and resume after this many seconds. Defaults to 1800 for those.' },
      quiet_seconds: { type: 'number', description: 'For terminal-finish: how long the output must stay quiet. Defaults to 5.' },
      label: { type: 'string', description: 'Short phrase completing "Will resume after …", such as "the test run finishes".' }
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
    const label = str(input, 'label')
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
        label: label ?? `${seconds} seconds`,
        start(fire) {
          const timer = setTimeout(() => fire(`${seconds} seconds have passed.`), timeoutMs)
          return () => clearTimeout(timer)
        }
      }
    } else if (trigger === 'subagent-finish') {
      const team = ctx.session.team
      const target = str(input, 'target', true)
      if (!team?.has(target)) throw new ToolInputError(`No subagent with ID ${target}. Use Message action=list to find IDs.`)
      event = {
        label: label ?? `${team.name(target)} finishes`,
        keepsTeam: true,
        start: withTimeout((fire) => {
          let stopped = false
          void team.wait(target).then((report) => { if (!stopped) fire(`Subagent ${target} (${team.name(target)}) finished. Its report:\n\n${report}`) })
          return () => { stopped = true }
        })
      }
    } else {
      const target = str(input, 'target', true)
      const quietMs = (num(input, 'quiet_seconds') ?? 5) * 1000
      if (!terminals.list().some((tab) => tab.tabId === target)) throw new ToolInputError(`No open terminal with tabId ${target}. Use Terminal action=list to find IDs.`)
      const tail = (): string => terminals.read(target).slice(-4000)
      event = {
        label: label ?? 'the terminal command finishes',
        start: withTimeout((fire) => {
          let quiet = setTimeout(() => fire(`The terminal output has been quiet for ${quietMs / 1000} seconds. Its end:\n\n${tail()}`), quietMs)
          const stop = terminals.watch(target, (exited) => {
            clearTimeout(quiet)
            if (exited) fire(`The terminal process exited. The end of its output:\n\n${tail()}`)
            else quiet = setTimeout(() => fire(`The terminal output has been quiet for ${quietMs / 1000} seconds. Its end:\n\n${tail()}`), quietMs)
          })
          return () => { clearTimeout(quiet); stop() }
        })
      }
    }
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
