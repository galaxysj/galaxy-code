import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { accountEnabled } from '@shared/catalog'
import type { UsageReport, UsageWindow } from '@shared/types'
import { startCodexProcess } from '../engines/codex'
import { store } from '../store'
import { errorMessage, which } from '../util'
import { openRouterCredits } from './openrouter'

type Json = Record<string, unknown>

/** OpenRouter credits, plus plan limits for the Claude and Codex accounts that are switched on. */
export async function usageReport(): Promise<UsageReport> {
  const [openrouter, claude, codex] = await Promise.all([
    store.openRouterKey ? openRouterCredits().catch((err: unknown) => ({ error: errorMessage(err) })) : null,
    accountEnabled(store.settings, 'claude') ? claudeUsage().catch((err: unknown) => ({ windows: [], error: errorMessage(err) })) : null,
    accountEnabled(store.settings, 'codex') ? codexUsage().catch((err: unknown) => ({ windows: [], error: errorMessage(err) })) : null
  ])
  return { openrouter, claude, codex }
}

/** Asks the Claude Code CLI for its /usage data without sending a prompt. */
async function claudeUsage(): Promise<{ plan: string | null; windows: UsageWindow[]; error?: string }> {
  const account = store.settings.accounts.claude
  const executable = account.binaryPath.trim() ? await which(account.binaryPath.trim()) : await which('claude')
  const controller = new AbortController()
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  async function* idle(): AsyncGenerator<SDKUserMessage> {
    await held
  }
  const session = query({
    prompt: idle(),
    options: {
      abortController: controller,
      env: { ...(process.env as Record<string, string>), CLAUDE_AGENT_SDK_CLIENT_APP: 'galaxy-code/0.1.0' },
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {})
    }
  })
  try {
    const usage = (await Promise.race([
      session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true } as never),
      new Promise((_, fail) => setTimeout(() => fail(new Error('Claude did not answer in time')), 30000))
    ])) as { subscription_type?: string | null; rate_limits_available?: boolean; rate_limits?: Record<string, { utilization: number | null; resets_at: string | null } | null> | null }
    const labels: Record<string, string> = { five_hour: '5-hour limit', seven_day: 'Weekly limit', seven_day_opus: 'Weekly Opus', seven_day_sonnet: 'Weekly Sonnet' }
    const windows = Object.entries(usage.rate_limits ?? {}).flatMap(([id, window]) =>
      window && typeof window.utilization === 'number' && labels[id] ? [{ label: labels[id], usedPercent: window.utilization, resetsAt: window.resets_at }] : []
    )
    return {
      plan: usage.subscription_type ?? null,
      windows,
      ...(usage.rate_limits_available === false ? { error: 'Plan limits are not available for this sign-in (API key or third-party provider).' } : {})
    }
  } finally {
    release()
    controller.abort()
  }
}

/** Reads the signed-in ChatGPT plan's rate-limit windows from the Codex app server. */
async function codexUsage(): Promise<{ plan: string | null; windows: UsageWindow[]; error?: string }> {
  const rpc = await startCodexProcess()
  try {
    const result = await rpc.request<Json>('account/rateLimits/read', {}, 20000)
    const limits = (result.rateLimits ?? result) as Json
    const windows: UsageWindow[] = []
    for (const [key, label] of [['primary', 'Short-term limit'], ['secondary', 'Weekly limit']] as const) {
      const window = limits[key] as Json | null | undefined
      if (!window || typeof window.usedPercent !== 'number') continue
      const minutes = typeof window.windowDurationMins === 'number' ? window.windowDurationMins : null
      const resets = typeof window.resetsAt === 'number' ? new Date(window.resetsAt * 1000).toISOString() : typeof window.resetsAt === 'string' ? window.resetsAt : null
      windows.push({ label: minutes ? windowLabel(minutes) : label, usedPercent: window.usedPercent, resetsAt: resets })
    }
    const plan = typeof limits.planType === 'string' ? limits.planType : null
    return { plan, windows, ...(windows.length ? {} : { error: 'Codex reported no plan limits.' }) }
  } finally {
    rpc.kill()
  }
}

function windowLabel(minutes: number): string {
  if (minutes >= 60 * 24 * 7 - 60) return 'Weekly limit'
  if (minutes >= 60 * 24) return `${Math.round(minutes / 60 / 24)}-day limit`
  if (minutes >= 60) return `${Math.round(minutes / 60)}-hour limit`
  return `${minutes}-minute limit`
}
