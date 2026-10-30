import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { findModel, resolveModels } from '@shared/catalog'
import type { AnalyticsRow } from '@shared/types'
import { store } from '../store'
import { writeJsonAtomic } from '../util'
import { standardPrices } from './openrouter'

/** Token and cost totals per local day and model, kept apart from chats so deleting a chat keeps its spend. */
type Totals = Record<string, { input: number; output: number; cost: number; calls: number }>

let totals: Totals | null = null
let timer: NodeJS.Timeout | null = null

function file(): string {
  return join(store.dataDir, 'analytics.json')
}

function load(): Totals {
  if (!totals) {
    try {
      totals = JSON.parse(readFileSync(file(), 'utf8')) as Totals
    } catch {
      totals = seedFromChats()
    }
  }
  return totals
}

/** First run: start from each chat's running totals, dated by its last activity, so earlier spend shows up. */
function seedFromChats(): Totals {
  const seeded: Totals = {}
  for (const chat of store.chats.values()) {
    const { inputTokens, outputTokens, cost } = chat.usage ?? { inputTokens: 0, outputTokens: 0, cost: 0 }
    if (!inputTokens && !outputTokens && !cost) continue
    const entry = (seeded[`${dayOf(new Date(chat.updatedAt))}|${chat.modelKey}`] ??= { input: 0, output: 0, cost: 0, calls: 0 })
    entry.input += inputTokens
    entry.output += outputTokens
    entry.cost += cost
  }
  void writeJsonAtomic(file(), seeded)
  return seeded
}

function dayOf(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export function recordUsage(modelKey: string, input: number, output: number, cost: number): void {
  if (!input && !output && !cost) return
  const data = load()
  const key = `${dayOf(new Date())}|${modelKey}`
  const entry = (data[key] ??= { input: 0, output: 0, cost: 0, calls: 0 })
  entry.input += input
  entry.output += output
  entry.cost += cost
  entry.calls += 1
  if (!timer)
    timer = setTimeout(() => {
      timer = null
      void writeJsonAtomic(file(), load())
    }, 2000)
}

/** The id OpenRouter lists a model under. Account models name the same model their own way, such as claude-opus-5-5. */
function priceId(modelKey: string): string {
  const subscription = modelKey.slice(0, modelKey.indexOf(':'))
  const id = modelKey.slice(modelKey.indexOf(':') + 1)
  if (subscription === 'Claude') return `anthropic/${id.replace(/-(\d+)-(\d+)$/, '-$1.$2')}`
  if (subscription === 'Codex') return `openai/${id}`
  return id
}

export async function analyticsRows(): Promise<AnalyticsRow[]> {
  const models = resolveModels(store.settings)
  const prices = await standardPrices()
  return Object.entries(load()).map(([key, entry]) => {
    const [day, modelKey] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)]
    const model = findModel(models, modelKey)
    const subscription = modelKey.slice(0, modelKey.indexOf(':'))
    const price = prices.get(priceId(modelKey))
    const equivalent = !entry.cost && price ? entry.input * price.input + entry.output * price.output : 0
    return { day, modelKey, name: model?.name ?? modelKey.slice(modelKey.indexOf(':') + 1), subscription: model?.subscription ?? subscription, ...entry, equivalent }
  })
}
