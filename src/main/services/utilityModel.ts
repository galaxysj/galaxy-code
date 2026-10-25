import type { AccountUtilityModelSpec } from '@shared/models'
import { claudeUtility, codexUtility } from './accountWorkers'
import { complete, streamChat } from './openrouter'

export interface UtilityRun {
  cwd: string
  signal: AbortSignal
  /** Called with the whole reply so far as it streams. */
  onText?: (text: string) => void
  /** OpenRouter request fields such as max_tokens; the account CLIs pick their own sampling. */
  openRouterExtra?: Record<string, unknown>
}

/** One reply from a utility model on its own connection. Account models run on a warm CLI, see accountWorkers.ts. */
export async function runUtilityModel(model: AccountUtilityModelSpec, system: string, prompt: string, run: UtilityRun): Promise<string> {
  const request = { system, prompt, cwd: run.cwd, signal: run.signal, onText: run.onText }
  if (model.Subscription === 'Claude') return claudeUtility(model.ID, request)
  if (model.Subscription === 'Codex') return codexUtility(model.ID, request)
  const messages = [{ role: 'system' as const, content: system }, { role: 'user' as const, content: prompt }]
  if (!run.onText) return complete(model.ID, messages, run.signal, run.openRouterExtra)
  let text = ''
  const onText = run.onText
  const result = await streamChat({
    model: model.ID,
    messages,
    signal: run.signal,
    // Thinking would hold back the first streamed line for a long time.
    effort: 'none',
    onText(delta) {
      text += delta
      onText(text)
    },
    onReasoning() {}
  })
  return result.content || text
}
