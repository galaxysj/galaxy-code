import { terminals } from '../services/terminal'
import { str, type ToolDef } from './types'

export const terminalTool: ToolDef = {
  name: 'Terminal', kind: 'bash',
  description: 'Control a persistent terminal tab visible beside the chat. list returns IDs of all open terminals, including user-created tabs. create opens a workspace shell and returns its tabId. write sends text (include a newline to run a command), read returns recent output, interrupt sends Ctrl+C, close ends the session. Commands run asynchronously; read checks their output. Use Bash when you need a command result that waits for completion.',
  parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'create', 'write', 'read', 'interrupt', 'close'] }, tabId: { type: 'string' }, text: { type: 'string' } }, required: ['action'] },
  present(input) {
    const titles: Record<string, string> = { create: 'Opened terminal', list: 'Listed terminals', write: 'Wrote to terminal', read: 'Read terminal output', interrupt: 'Interrupted terminal', close: 'Closed terminal' }
    return { title: titles[String(input.action)] ?? 'Terminal' }
  },
  approval(input) {
    if (input.action !== 'write' && input.action !== 'interrupt' && input.action !== 'close') return null
    return { action: { tool: 'Terminal', ...input }, sessionKey: 'terminal', sessionLabel: 'Allow terminal control in this chat' }
  },
  async execute(input, ctx) {
    const action = str(input, 'action', true)
    if (action === 'list') return { text: JSON.stringify(terminals.list()) }
    if (action === 'create') {
      const tabId = await terminals.create(ctx.cwd)
      ctx.session.emitUi({ type: 'open-panel', chatId: ctx.session.id, pane: 'terminal', tabId, cwd: ctx.cwd })
      return { text: `Opened terminal tab ${tabId}.` }
    }
    const tabId = str(input, 'tabId', true)
    switch (action) {
      case 'write': terminals.write(tabId, str(input, 'text', true)); break
      case 'read': return { text: terminals.read(tabId) || '(No output yet.)' }
      case 'interrupt': terminals.interrupt(tabId); break
      case 'close': terminals.close(tabId); ctx.session.emitUi({ type: 'close-panel-tab', tabId }); break
      default: throw new Error('Unknown terminal action.')
    }
    return { text: `Terminal ${action} completed.` }
  }
}
