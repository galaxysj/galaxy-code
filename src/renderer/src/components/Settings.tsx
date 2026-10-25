import {
  ArrowLeft,
  Box,
  Gauge,
  Boxes,
  Cable,
  Check,
  CircleAlert,
  Cpu,
  KeyRound,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  UserRound
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ACCOUNT_LABELS,
  ACP_ACCOUNTS,
  KEYLESS_ACCOUNTS,
  SUBSCRIPTIONS,
  acpAgentFor,
  accountSubscription,
  type AccountId,
  type AnalyticsRow,
  type CustomAcpAgent,
  type McpServerConfig,
  type PermissionMode,
  type PlanUsage,
  type SkillInfo,
  type Subscription,
  type TerminalOutputMode,
  type ToolDensity,
  type ThemeMode,
  type UsageReport,
  type UsageWindow
} from '@shared/types'
import { AcpAgents } from '@shared/acp-registry'
import { AutoApprovalModel, CommitMessageModel, CompletionModel, InlineModel, resolveAutoApprovalModel, usableUtilityModels, utilityModelLabel } from '@shared/models'
import { cn, tildify } from '../lib/utils'
import { useStore, type SettingsSection } from '../store'
import { SUBSCRIPTION_LABELS } from './ModelPicker'
import { Button, Dropdown, IconButton, Segmented, Spinner, Switch, TextInput, type DropdownOption } from './ui'

const SECTIONS: { id: SettingsSection; label: string; icon: typeof Cpu }[] = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'models', label: 'Models', icon: Boxes },
  { id: 'providers', label: 'Providers', icon: KeyRound },
  { id: 'accounts', label: 'AI accounts', icon: UserRound },
  { id: 'usage', label: 'Usage', icon: Gauge },
  { id: 'acp', label: 'ACP agents', icon: Cable },
  { id: 'mcp', label: 'MCP servers', icon: Plug },
  { id: 'skills', label: 'Skills & memory', icon: Box }
]

function Section({ title, description, children, action }: { title: string; description?: ReactNode; children: ReactNode; action?: ReactNode }): ReactNode {
  return (
    <section className="mb-7 last:mb-0">
      <div className="mb-2.5 flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
          {description && <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function Card({ children, className }: { children: ReactNode; className?: string }): ReactNode {
  return <div className={cn('divide-y divide-line rounded-xl border border-line bg-elev', className)}>{children}</div>
}

function RowItem({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }): ReactNode {
  return (
    <div className="flex min-h-[44px] items-center gap-4 px-3.5 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] text-fg">{label}</div>
        {hint && <div className="mt-0.5 text-[11.5px] leading-snug text-muted">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

function Select<T extends string>({ className, ...rest }: { label: string; value: T; options: DropdownOption<T>[]; onChange(value: T): void; className?: string }): ReactNode {
  return <Dropdown placement="bottom-end" className={cn('h-7.5! max-w-[240px] border border-line-strong bg-inset! text-[12.5px]! hover:bg-hover!', className)} {...rest} />
}

function cleanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

// General

function GeneralSection(): ReactNode {
  const settings = useStore((s) => s.settings)
  const update = useStore((s) => s.updateSettings)
  const version = useStore((s) => s.version)
  const commitModels = usableUtilityModels(CommitMessageModel, settings.accounts)
  return (
    <>
      <Section title="Appearance">
        <Card>
          <RowItem label="Theme">
            <Segmented<ThemeMode>
              value={settings.theme}
              onChange={(theme) => void update({ theme })}
              options={[
                { value: 'system', label: 'System' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' }
              ]}
            />
          </RowItem>
          <RowItem label="Tool density" hint="Medium shows commands and edits as single lines, like &quot;Edited App.tsx&quot;, that open in place. Compact folds every run of tool calls into one summary line.">
            <Segmented<ToolDensity>
              value={settings.toolDensity}
              onChange={(toolDensity) => void update({ toolDensity })}
              options={[
                { value: 'default', label: 'Default' },
                { value: 'medium', label: 'Medium' },
                { value: 'compact', label: 'Compact' }
              ]}
            />
          </RowItem>
          <RowItem label="Expand tool calls" hint="Open tool groups while they run. Off shows only their summary line, such as &quot;Explored 3 files&quot;, until you click it.">
            <Switch checked={settings.expandToolCalls !== false} onChange={(expandToolCalls) => void update({ expandToolCalls })} label="Expand tool calls" />
          </RowItem>
          <RowItem label="Fold finished work" hint="Collapse a finished turn's steps under &quot;Worked for&quot; above its final response.">
            <Switch checked={settings.foldWork} onChange={(foldWork) => void update({ foldWork })} label="Fold finished work" />
          </RowItem>
          <RowItem label="Tool output" hint="Controls command output and file edit previews. Click a tool to expand its output.">
            <Select<TerminalOutputMode>
              label="Terminal output"
              value={settings.terminalOutput}
              onChange={(value) => void update({ terminalOutput: value })}
              options={[
                { value: 'collapsed', label: 'Always collapsed' },
                { value: 'foreground', label: 'Expand while running' },
                { value: 'preview', label: 'Always show a scrolling preview' }
              ]}
            />
          </RowItem>
        </Card>
      </Section>
      <Section title="Composer">
        <Card>
          <RowItem label="Model picker style" hint="Default lists models with their effort and options beside them. Slider shows one model with an effort slider.">
            <Segmented<'default' | 'slider'>
              value={settings.modelPickerStyle ?? 'default'}
              onChange={(modelPickerStyle) => void update({ modelPickerStyle })}
              options={[
                { value: 'default', label: 'Default' },
                { value: 'slider', label: 'Slider' }
              ]}
            />
          </RowItem>
        </Card>
      </Section>
      <Section title="Git">
        <Card>
          <RowItem label="Instant commit" hint="Commit and Commit &amp; Push commit right away with a message written by the model below, instead of asking the agent. Mentioning @Commit still asks the agent.">
            <Switch checked={settings.instantCommit} onChange={(instantCommit) => void update({ instantCommit })} label="Instant commit" />
          </RowItem>
          {settings.instantCommit && (
            <RowItem label="Commit message model" hint="OpenRouter models run on your OpenRouter key. Claude and Codex models run on that signed-in account.">
              <Select
                label="Commit message model"
                value={commitModels.some((m) => m.ID === settings.commitMessageModelId) ? (settings.commitMessageModelId as string) : commitModels[0].ID}
                onChange={(value) => void update({ commitMessageModelId: value })}
                options={commitModels.map((model) => ({ value: model.ID, label: utilityModelLabel(model) }))}
              />
            </RowItem>
          )}
          <RowItem label="Instant push" hint="Push pushes the current branch right away instead of asking the agent. Commit &amp; Push follows Instant commit. Mentioning @Push still asks the agent.">
            <Switch checked={settings.instantPush} onChange={(instantPush) => void update({ instantPush })} label="Instant push" />
          </RowItem>
        </Card>
      </Section>
      <Section title="Permissions" description="How new chats start. You can change the mode for any chat from the message box.">
        <Card>
          <RowItem label="Default permission mode">
            <Select<PermissionMode>
              label="Default permission mode"
              value={settings.defaultPermissionMode}
              onChange={(value) => void update({ defaultPermissionMode: value })}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'ask', label: 'Ask for Approval' },
                { value: 'accept-edits', label: 'Accept Edits' },
                { value: 'full', label: 'Full Access' }
              ]}
            />
          </RowItem>
          <RowItem
            label="Auto approval model"
            hint="Auto reviews each action with this model. A deny probability of 50% or more asks for your approval in the message box. It needs an OpenRouter key."
          >
            <Select
              label="Auto approval model"
              value={resolveAutoApprovalModel(settings.autoApprovalModelId).ID}
              onChange={(value) => void update({ autoApprovalModelId: value })}
              options={AutoApprovalModel.map((model) => ({ value: model.ID, label: model.DisplayName }))}
            />
          </RowItem>
        </Card>
      </Section>
      <Section title="About">
        <Card>
          <RowItem label="Galaxy Code" hint="A desktop agent manager for coding agents.">
            <span className="shrink-0 font-mono text-[11.5px] text-muted">v{version}</span>
          </RowItem>
        </Card>
      </Section>
    </>
  )
}

// Models

/** ACP agents report their own models, so the model list leaves them out. */
const MODEL_SUBSCRIPTIONS = SUBSCRIPTIONS.filter((sub) => !acpAgentFor(sub))

function ModelsSection(): ReactNode {
  const settings = useStore((s) => s.settings)
  const models = useStore((s) => s.models)
  const imageModels = useStore((s) => s.imageModels)
  const update = useStore((s) => s.updateSettings)
  const notify = useStore((s) => s.notify)
  const completionModels = usableUtilityModels(CompletionModel, settings.accounts)
  const inlineModels = usableUtilityModels(InlineModel, settings.accounts)
  const [name, setName] = useState('')
  const [id, setId] = useState('')
  const [subscription, setSubscription] = useState<Subscription>('Default')
  const [adding, setAdding] = useState(false)

  const toggle = (key: string, enabled: boolean): void => {
    if (models.find((m) => m.key === key)?.defaultOff) {
      const on = new Set(settings.enabledModels ?? [])
      if (enabled) on.add(key)
      else on.delete(key)
      void update({ enabledModels: [...on] })
      return
    }
    const disabled = new Set(settings.disabledModels)
    if (enabled) disabled.delete(key)
    else disabled.add(key)
    void update({ disabledModels: [...disabled] })
  }

  const add = (): void => {
    const modelId = id.trim()
    const display = name.trim() || modelId
    if (!modelId) return
    if (models.some((m) => m.id === modelId && m.subscription === subscription)) {
      notify('That model is already in the list', 'error')
      return
    }
    void update({ customModels: [...settings.customModels, { name: display, id: modelId, subscription }] })
    setName('')
    setId('')
    setAdding(false)
  }

  const remove = (modelId: string, sub: Subscription): void => {
    void update({
      customModels: settings.customModels.filter((m) => !(m.id === modelId && m.subscription === sub)),
      disabledModels: settings.disabledModels.filter((key) => key !== `${sub}:${modelId}`)
    })
  }

  // Enabled models lead each group; the order is fixed when the page opens so rows don't jump on toggle.
  const [leading] = useState(() => new Set(models.filter((m) => m.enabled).map((m) => m.key)))
  const ranked = models.filter((m) => !m.auto).sort((a, b) => Number(leading.has(b.key)) - Number(leading.has(a.key)))
  const groups = MODEL_SUBSCRIPTIONS.map((sub) => ({ sub, models: ranked.filter((m) => m.subscription === sub) })).filter((g) => g.models.length > 0)
  const imageKey = imageModels.some((m) => m.key === settings.imageModelKey) ? (settings.imageModelKey as string) : (imageModels[0]?.key ?? '')

  return (
    <>
      <Section title="Image generation" description="The model the ImageGeneration tool uses.">
        <Card>
          <RowItem label="Image Generation Model">
            <Select label="Image model" value={imageKey} onChange={(value) => void update({ imageModelKey: value })} options={imageModels.map((model) => ({ value: model.key, label: model.name }))} />
          </RowItem>
        </Card>
      </Section>

      <Section title="Editor" description="Models for editing files in the Files panel, listed in src/shared/models.ts. OpenRouter models run on your OpenRouter key.">
        <Card>
          <RowItem label="Tab completion" hint="Suggests the rest of the line as you type; Tab accepts it.">
            <Switch checked={settings.tabCompletion !== false} onChange={(tabCompletion) => void update({ tabCompletion })} label="Tab completion" />
          </RowItem>
          <RowItem label="Completion model" hint="Claude and Codex models run on that signed-in account through a CLI kept running in the background. The first suggestion after a pause starts it, so it is slower.">
            <Select
              label="Completion model"
              value={completionModels.some((m) => m.ID === settings.completionModelId) ? (settings.completionModelId as string) : completionModels[0].ID}
              onChange={(value) => void update({ completionModelId: value })}
              options={completionModels.map((model) => ({ value: model.ID, label: utilityModelLabel(model) }))}
            />
          </RowItem>
          <RowItem label="Inline edit model" hint="Ctrl+I in the editor. The edit box can switch it too.">
            <Select
              label="Inline edit model"
              value={inlineModels.some((m) => m.ID === settings.inlineModelId) ? (settings.inlineModelId as string) : inlineModels[0].ID}
              onChange={(value) => void update({ inlineModelId: value })}
              options={inlineModels.map((model) => ({ value: model.ID, label: utilityModelLabel(model) }))}
            />
          </RowItem>
        </Card>
      </Section>

      <Section
        title="Agent models"
        description="Turn a model off to hide it from the model picker."
        action={
          <IconButton label="Add a custom model" active={adding} onClick={() => setAdding(!adding)}>
            <Plus size={15} />
          </IconButton>
        }
      >
        {adding && (
          <div className="activity-reveal mb-4 rounded-xl border border-line bg-elev p-4">
            <div className="mb-3">
              <div className="text-[12.5px] font-medium text-fg">Add a custom model</div>
              <div className="mt-0.5 text-[11.5px] text-muted">Use any model id your subscription or OpenRouter accepts.</div>
            </div>
            <div className="space-y-2.5">
              <label className="flex items-center gap-3">
                <span className="w-24 shrink-0 text-[12px] text-muted">Name</span>
                <TextInput autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Display name" className="flex-1" />
              </label>
              <label className="flex items-center gap-3">
                <span className="w-24 shrink-0 text-[12px] text-muted">Model ID</span>
                <TextInput
                  value={id}
                  onChange={(event) => setId(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') add()
                  }}
                  placeholder="vendor/model-name"
                  className="flex-1 font-mono text-[12px]"
                />
              </label>
              <label className="flex items-center gap-3">
                <span className="w-24 shrink-0 text-[12px] text-muted">Subscription</span>
                <Select<Subscription>
                  label="Subscription"
                  value={subscription}
                  onChange={setSubscription}
                  className="max-w-none flex-1"
                  options={MODEL_SUBSCRIPTIONS.map((sub) => ({ value: sub, label: sub === 'Default' ? 'Default (OpenRouter)' : (SUBSCRIPTION_LABELS[sub] ?? sub) }))}
                />
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button size="sm" onClick={() => setAdding(false)}>Cancel</Button>
              <Button variant="primary" size="sm" disabled={!id.trim()} onClick={add}>
                <Plus size={13} /> Add model
              </Button>
            </div>
          </div>
        )}
        <div className="space-y-3">
          {groups.map((group) => (
            <div key={group.sub}>
              <div className="mb-1 px-1 text-[11px] font-medium text-subtle">{(SUBSCRIPTION_LABELS[group.sub] ?? group.sub)}</div>
              <Card>
                {group.models.map((model) => (
                  <div key={model.key} className="flex h-10 items-center gap-3 px-3.5">
                    <div className="min-w-0 flex-1">
                      <span className={cn('text-[12.5px]', model.enabled ? 'text-fg' : 'text-subtle')}>{model.name}</span>
                      <span className="ml-2 font-mono text-[11px] text-subtle">{model.id}</span>
                    </div>
                    {model.custom && <span className="shrink-0 rounded bg-hover px-1.5 py-px text-[10.5px] text-muted">Custom</span>}
                    {model.custom && (
                      <IconButton label="Remove model" size="sm" onClick={() => remove(model.id, model.subscription)}>
                        <Trash2 size={12.5} />
                      </IconButton>
                    )}
                    <Switch checked={model.enabled} onChange={(next) => toggle(model.key, next)} label={`Show ${model.name}`} />
                  </div>
                ))}
              </Card>
            </div>
          ))}
        </div>
      </Section>

    </>
  )
}

// Usage

function UsageBar({ window }: { window: UsageWindow }): ReactNode {
  const used = Math.max(0, Math.min(100, window.usedPercent))
  const resets = window.resetsAt ? new Date(window.resetsAt) : null
  return (
    <div className="px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12.5px] text-fg">{window.label}</span>
        <span className="text-[12px] tabular-nums text-muted">{Math.round(used)}% used</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-hover">
        <div className={cn('h-full rounded-full', used >= 90 ? 'bg-danger' : used >= 70 ? 'bg-warn' : 'bg-[var(--slider)]')} style={{ width: `${used}%` }} />
      </div>
      {resets && !Number.isNaN(resets.getTime()) && <div className="mt-1.5 text-[11.5px] text-subtle">Resets {resets.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>}
    </div>
  )
}

function PlanCard({ usage }: { usage: PlanUsage }): ReactNode {
  return (
    <Card>
      {usage.plan && <RowItem label="Plan"><span className="text-[12.5px] capitalize text-muted">{usage.plan}</span></RowItem>}
      {usage.windows.map((window) => <UsageBar key={window.label} window={window} />)}
      {usage.error && <div className="px-3.5 py-3 text-[12px] text-muted">{usage.error}</div>}
    </Card>
  )
}

type AnalyticsRange = '7' | '30' | 'all'

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`
  return String(Math.round(value))
}

function cost(value: number): string {
  return value > 0 && value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`
}

/** Spend and tokens per model, from what Galaxy Code recorded on this computer. */
function AnalyticsSection({ rows }: { rows: AnalyticsRow[] | null }): ReactNode {
  const [range, setRange] = useState<AnalyticsRange>('30')
  const view = useMemo(() => {
    const all = rows ?? []
    const days = range === 'all' ? null : Number(range)
    const since = days ? dayKey(new Date(Date.now() - (days - 1) * 86_400_000)) : ''
    const picked = all.filter((row) => row.day >= since)
    const byModel = new Map<string, { name: string; subscription: string; input: number; output: number; cost: number; calls: number }>()
    for (const row of picked) {
      const entry = byModel.get(row.modelKey) ?? { name: row.name, subscription: row.subscription, input: 0, output: 0, cost: 0, calls: 0 }
      entry.input += row.input
      entry.output += row.output
      entry.cost += row.cost
      entry.calls += row.calls
      byModel.set(row.modelKey, entry)
    }
    const models = [...byModel.entries()].map(([key, entry]) => ({ key, ...entry, tokens: entry.input + entry.output })).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens)
    const chartDays = days ?? Math.min(90, Math.max(7, picked.length ? Math.ceil((Date.now() - new Date(picked.reduce((min, row) => (row.day < min ? row.day : min), picked[0].day)).getTime()) / 86_400_000) + 1 : 7))
    const daily = Array.from({ length: chartDays }, (_, index) => {
      const day = dayKey(new Date(Date.now() - (chartDays - 1 - index) * 86_400_000))
      const today = picked.filter((row) => row.day === day)
      return { day, cost: today.reduce((sum, row) => sum + row.cost, 0), tokens: today.reduce((sum, row) => sum + row.input + row.output, 0) }
    })
    return {
      models,
      daily,
      cost: models.reduce((sum, m) => sum + m.cost, 0),
      tokens: models.reduce((sum, m) => sum + m.tokens, 0),
      calls: models.reduce((sum, m) => sum + m.calls, 0)
    }
  }, [rows, range])
  // Subscription plans report no cost, so the chart falls back to tokens when nothing was paid.
  const byCost = view.cost > 0
  const peak = Math.max(...view.daily.map((d) => (byCost ? d.cost : d.tokens)), 0)
  const topShare = Math.max(...view.models.map((m) => (byCost ? m.cost : m.tokens)), 0)

  return (
    <Section
      title="Analytics"
      description="Recorded on this computer for every request Galaxy Code sends. Subscription accounts count tokens but not cost."
      action={<Segmented<AnalyticsRange> value={range} onChange={setRange} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: 'all', label: 'All' }]} />}
    >
      {!rows ? (
        <div className="flex justify-center py-6"><Spinner size={16} className="text-subtle" /></div>
      ) : (
        <Card>
          <div className="grid grid-cols-3 px-4 pb-3 pt-4">
            {[['Spent', cost(view.cost)], ['Tokens', compactNumber(view.tokens)], ['Requests', compactNumber(view.calls)]].map(([label, value]) => (
              <div key={label}>
                <div className="text-[11.5px] text-muted">{label}</div>
                <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-fg">{value}</div>
              </div>
            ))}
          </div>
          <div className="px-4 pb-5 pt-3">
            <div className="flex h-16 items-end gap-[2px]">
              {view.daily.map((d) => {
                const value = byCost ? d.cost : d.tokens
                return (
                  <div
                    key={d.day}
                    title={`${new Date(`${d.day}T00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${byCost ? cost(d.cost) : `${compactNumber(d.tokens)} tokens`}`}
                    className="flex h-full min-w-0 flex-1 items-end rounded-[2px] hover:bg-hover"
                  >
                    <div className="w-full rounded-[2px] bg-[var(--slider)]" style={{ height: peak > 0 && value > 0 ? `${Math.max(4, (value / peak) * 100)}%` : '0%' }} />
                  </div>
                )
              })}
            </div>
            <div className="mt-1 flex justify-between text-[10.5px] text-subtle">
              <span>{new Date(`${view.daily[0].day}T00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
              <span>Today</span>
            </div>
          </div>
          {view.models.length === 0 ? (
            <div className="px-3.5 py-3 text-[12px] text-muted">No usage in this period yet.</div>
          ) : (
            view.models.map((model) => {
              const value = byCost ? model.cost : model.tokens
              return (
                <div key={model.key} className="px-3.5 py-2.5">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 truncate text-[12.5px] text-fg">{model.name}</span>
                    <span className="shrink-0 text-[11px] text-subtle">{model.subscription === 'Default' ? 'OpenRouter' : (SUBSCRIPTION_LABELS[model.subscription] ?? model.subscription)}</span>
                    <span className="ml-auto shrink-0 text-[12px] tabular-nums text-muted">
                      {compactNumber(model.input)} in · {compactNumber(model.output)} out
                    </span>
                    <span className="w-16 shrink-0 text-right text-[12.5px] tabular-nums text-fg">{model.cost > 0 ? cost(model.cost) : '—'}</span>
                  </div>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-hover">
                    <div className="h-full rounded-full bg-[var(--slider)]" style={{ width: `${topShare > 0 ? (value / topShare) * 100 : 0}%` }} />
                  </div>
                </div>
              )
            })
          )}
        </Card>
      )}
    </Section>
  )
}

function UsageSection(): ReactNode {
  const [report, setReport] = useState<UsageReport | null>(null)
  const [rows, setRows] = useState<AnalyticsRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    setLoading(true)
    setError('')
    void window.galaxy.settings.analytics().then(setRows).catch(() => setRows([]))
    window.galaxy.settings.usage().then(setReport).catch((err: unknown) => setError(cleanError(err))).finally(() => setLoading(false))
  }, [])
  useEffect(load, [load])
  const money = (value: number): string => `$${value.toFixed(2)}`
  const openrouter = report?.openrouter
  return (
    <>
      <div className="-mt-3 mb-5 flex items-center justify-between gap-3">
        <p className="text-[12px] text-muted">Balances and plan limits for the providers that are switched on.</p>
        <Button size="sm" disabled={loading} onClick={load}>
          {loading ? <Spinner size={12} /> : <RefreshCw size={12.5} />} Refresh
        </Button>
      </div>
      {error && <p className="mb-4 text-[12px] text-danger">{error}</p>}
      {!report && loading && <div className="flex justify-center py-10"><Spinner size={16} className="text-subtle" /></div>}
      {report && (
        <>
          <Section title="OpenRouter">
            {!openrouter ? (
              <Card><div className="px-3.5 py-3 text-[12px] text-muted">Add an API key in Providers to see your credits.</div></Card>
            ) : 'error' in openrouter ? (
              <Card><div className="px-3.5 py-3 text-[12px] text-danger">{openrouter.error}</div></Card>
            ) : (
              <Card>
                <RowItem label="Credit balance"><span className="text-[15px] font-semibold tabular-nums text-fg">{money(openrouter.total - openrouter.used)}</span></RowItem>
                <div className="px-3.5 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[12.5px] text-fg">{money(openrouter.used)} used</span>
                    <span className="text-[12px] tabular-nums text-muted">of {money(openrouter.total)} purchased</span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-hover">
                    {(() => {
                      const used = openrouter.total > 0 ? Math.min(100, (openrouter.used / openrouter.total) * 100) : 0
                      return <div className={cn('h-full rounded-full', used >= 90 ? 'bg-danger' : used >= 70 ? 'bg-warn' : 'bg-[var(--slider)]')} style={{ width: `${used}%` }} />
                    })()}
                  </div>
                </div>
                {openrouter.keyLimit !== null && (
                  <RowItem label="This key's limit" hint={openrouter.keyRemaining !== null ? `${money(openrouter.keyRemaining)} left on this key` : undefined}>
                    <span className="text-[12.5px] tabular-nums text-muted">{money(openrouter.keyLimit)}</span>
                  </RowItem>
                )}
              </Card>
            )}
          </Section>
          {report.claude && <Section title="Claude"><PlanCard usage={report.claude} /></Section>}
          {report.codex && <Section title="Codex"><PlanCard usage={report.codex} /></Section>}
        </>
      )}
      <AnalyticsSection rows={rows} />
    </>
  )
}

// Providers

function ProvidersSection(): ReactNode {
  const secrets = useStore((s) => s.secrets)
  const settings = useStore((s) => s.settings)
  const update = useStore((s) => s.updateSettings)
  const [key, setKey] = useState('')
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const [busy, setBusy] = useState<'test' | 'signin' | null>(null)
  const [baseUrl, setBaseUrl] = useState(settings.openRouterBaseUrl)

  const save = async (): Promise<void> => {
    if (!key.trim()) return
    await window.galaxy.settings.setOpenRouterKey(key.trim())
    setKey('')
    setBusy('test')
    setStatus(await window.galaxy.settings.testOpenRouterKey())
    setBusy(null)
  }

  return (
    <>
      <Section
        title="OpenRouter"
        description="The default provider. Models marked OpenRouter, chat titles, image generation and Auto approval all run on this key. It is stored encrypted on this computer."
      >
        <Card>
          <RowItem
            label="API key"
            hint={secrets.openRouterKey ? <span className="font-mono">{secrets.openRouterKeyHint}</span> : 'No key saved'}
          >
            {secrets.openRouterKey ? (
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  size="sm"
                  disabled={busy !== null}
                  onClick={async () => {
                    setBusy('test')
                    setStatus(await window.galaxy.settings.testOpenRouterKey())
                    setBusy(null)
                  }}
                >
                  {busy === 'test' ? <Spinner size={12} /> : null} Test
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={async () => {
                    await window.galaxy.settings.setOpenRouterKey(null)
                    setStatus(null)
                  }}
                >
                  Remove
                </Button>
              </div>
            ) : (
              <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-warn">
                <CircleAlert size={13} /> Required
              </span>
            )}
          </RowItem>
          <div className="px-3.5 py-3">
            <div className="flex gap-2">
              <TextInput
                type="password"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void save()
                }}
                placeholder={secrets.openRouterKey ? 'Paste a new key to replace the saved one' : 'sk-or-v1-…'}
                className="font-mono text-[12px]"
              />
              <Button variant="primary" disabled={!key.trim()} onClick={() => void save()}>
                Save
              </Button>
            </div>
            <div className="mt-2.5 flex items-center gap-2">
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy('signin')
                  setStatus({ ok: true, message: 'Waiting for you to approve in the browser…' })
                  setStatus(await window.galaxy.settings.signInOpenRouter())
                  setBusy(null)
                }}
              >
                {busy === 'signin' ? <Spinner size={12} /> : null} Sign in with OpenRouter
              </Button>
              <button type="button" className="text-[12px] text-link hover:underline" onClick={() => void window.galaxy.files.openExternal('https://openrouter.ai/settings/keys')}>
                Get a key
              </button>
              {status && (
                <span className={cn('ml-auto flex min-w-0 items-center gap-1.5 text-[12px]', status.ok ? 'text-ok' : 'text-danger')}>
                  {status.ok ? <Check size={13} className="shrink-0" /> : <CircleAlert size={13} className="shrink-0" />}
                  <span className="truncate">{status.message}</span>
                </span>
              )}
            </div>
          </div>
        </Card>
      </Section>

      <Section title="Endpoint" description="Point the default provider at any OpenAI-compatible API. Leave it alone unless you know you need this.">
        <Card>
          <div className="flex items-center gap-2 px-3.5 py-3">
            <TextInput value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} className="font-mono text-[12px]" placeholder="https://openrouter.ai/api/v1" />
            <Button disabled={baseUrl.trim() === settings.openRouterBaseUrl} onClick={() => void update({ openRouterBaseUrl: baseUrl.trim() || 'https://openrouter.ai/api/v1' })}>
              Save
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setBaseUrl('https://openrouter.ai/api/v1')
                void update({ openRouterBaseUrl: 'https://openrouter.ai/api/v1' })
              }}
            >
              Reset
            </Button>
          </div>
        </Card>
      </Section>
    </>
  )
}

// Accounts

const ACCOUNT_NOTES: Record<AccountId, string> = {
  claude: 'Runs through your Claude Code login with the Claude Agent SDK.',
  codex: 'Runs through your ChatGPT login by driving codex app-server.',
  ...Object.fromEntries(AcpAgents.map((agent) => [agent.ID, agent.Description]))
}

/** Accounts Galaxy Code can start a sign-in for. The rest sign in from their own app. */
const CAN_SIGN_IN = new Set<AccountId>(['claude', 'codex', ...AcpAgents.filter((agent) => agent.Login).map((agent) => agent.ID)])

function AccountList({ ids, off = false }: { ids: AccountId[]; off?: boolean }): ReactNode {
  const settings = useStore((s) => s.settings)
  const update = useStore((s) => s.updateSettings)
  const models = useStore((s) => s.models)
  const notify = useStore((s) => s.notify)
  const homeDir = useStore((s) => s.homeDir)
  const statuses = useStore((s) => s.accountStatuses)
  const refresh = useStore((s) => s.refreshAccounts)
  const [editing, setEditing] = useState<AccountId | null>(null)
  const [path, setPath] = useState('')
  const [signingIn, setSigningIn] = useState<AccountId | null>(null)

  // Terminal sign-ins finish outside the app, so check again when the user comes back.
  useEffect(() => {
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const patchAccount = async (id: AccountId, patch: Partial<{ enabled: boolean; binaryPath: string }>): Promise<void> => {
    await update({ accounts: { ...settings.accounts, [id]: { ...settings.accounts[id], ...patch } } })
    if (patch.binaryPath !== undefined) void refresh()
  }

  const login = async (id: AccountId): Promise<void> => {
    setSigningIn(id)
    try {
      const result = await window.galaxy.accounts.login(id)
      notify(result.message, result.ok ? 'info' : 'error')
      void refresh()
    } finally {
      setSigningIn(null)
    }
  }

  return (
    <Card className={cn(off && 'opacity-50')}>
      {ids.map((id) => {
        const status = statuses?.find((s) => s.id === id)
        const config = settings.accounts[id]
        const subscription = accountSubscription(id)
        const count = ACP_ACCOUNTS.includes(id) ? 0 : models.filter((m) => m.subscription === subscription).length
        const state = !status
          ? { text: 'Checking…', tone: 'text-subtle' }
          : !status.installed
            ? { text: 'CLI not found', tone: 'text-subtle' }
            : status.authenticated !== true && KEYLESS_ACCOUNTS.includes(id)
              ? { text: 'Free models only', tone: 'text-muted' }
              : status.authenticated === false
                ? { text: 'Not signed in', tone: 'text-warn' }
                : status.authenticated === true
                  ? { text: status.detail ?? 'Signed in', tone: 'text-ok' }
                  : { text: 'Installed', tone: 'text-muted' }
        return (
          <div key={id} className="px-3.5 py-3">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[12.5px] font-medium text-fg">{ACCOUNT_LABELS[id]}</span>
                  <span className={cn('text-[11.5px]', state.tone)}>{state.text}</span>
                  {status?.version && <span className="font-mono text-[11px] text-subtle">v{status.version}</span>}
                </div>
                <div className="mt-0.5 text-[11.5px] leading-snug text-muted">
                  {ACCOUNT_NOTES[id]} {count > 0 ? `${count} model${count === 1 ? '' : 's'} in the picker.` : ''}
                </div>
              </div>
              {status?.installed && status.authenticated !== true && CAN_SIGN_IN.has(id) && (
                <Button size="sm" disabled={off || signingIn !== null} onClick={() => void login(id)}>
                  {signingIn === id ? <Spinner size={12} /> : null} Sign in
                </Button>
              )}
              <IconButton
                label="Set CLI path"
                size="sm"
                active={editing === id}
                disabled={off}
                onClick={() => {
                  setEditing(editing === id ? null : id)
                  setPath(config.binaryPath)
                }}
              >
                <Pencil size={12.5} />
              </IconButton>
              <Switch checked={config.enabled} disabled={off} onChange={(enabled) => void patchAccount(id, { enabled })} label={`Enable ${ACCOUNT_LABELS[id]}`} />
            </div>
            {editing === id && !off && (
              <div className="mt-2.5 flex gap-2">
                <TextInput
                  autoFocus
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      void patchAccount(id, { binaryPath: path.trim() })
                      setEditing(null)
                    }
                  }}
                  placeholder={status?.binary ? tildify(status.binary, homeDir) : 'Path to the CLI, leave empty to search PATH'}
                  className="font-mono text-[12px]"
                />
                <Button
                  size="md"
                  onClick={() => {
                    void patchAccount(id, { binaryPath: path.trim() })
                    setEditing(null)
                  }}
                >
                  Save
                </Button>
              </div>
            )}
          </div>
        )
      })}
    </Card>
  )
}

function RefreshAccountsButton(): ReactNode {
  const loading = useStore((s) => s.accountsLoading)
  const refresh = useStore((s) => s.refreshAccounts)
  useEffect(() => {
    void refresh()
  }, [refresh])
  return (
    <Button size="sm" onClick={() => void refresh()} disabled={loading}>
      {loading ? <Spinner size={12} /> : <RefreshCw size={12} />} Check again
    </Button>
  )
}

function AccountsSection(): ReactNode {
  const ids = (Object.keys(ACCOUNT_LABELS) as AccountId[]).filter((id) => !ACP_ACCOUNTS.includes(id))
  return (
    <Section
      title="AI accounts"
      description="Use subscriptions you already pay for. Each account runs its own CLI on this computer; Galaxy Code adds its browser, questions, deliverables, memory and image tools on top."
      action={<RefreshAccountsButton />}
    >
      <AccountList ids={ids} />
    </Section>
  )
}

function AcpSection(): ReactNode {
  const enabled = useStore((s) => s.settings.acpEnabled !== false)
  const update = useStore((s) => s.updateSettings)
  const builtin = AcpAgents.filter((agent) => !agent.Custom).map((agent) => agent.ID)
  return (
    <>
      <Section
        title="ACP agents"
        description="Coding agents that Galaxy Code reaches over the Agent Client Protocol. Each agent reports its own models and modes, which the composer shows in place of the model picker."
      >
        <Card>
          <RowItem label="Use ACP agents" hint="Turns every agent below on or off at once. Each agent keeps its own switch.">
            <Switch checked={enabled} onChange={(acpEnabled) => void update({ acpEnabled })} label="Use ACP agents" />
          </RowItem>
        </Card>
      </Section>
      <Section title="Agents" action={<RefreshAccountsButton />}>
        <AccountList ids={builtin} off={!enabled} />
      </Section>
      <CustomAcpSection off={!enabled} />
    </>
  )
}

function CustomAcpEditor({ initial, taken, onSave, onCancel }: { initial: CustomAcpAgent | null; taken: string[]; onSave(agent: CustomAcpAgent): void; onCancel(): void }): ReactNode {
  const [name, setName] = useState(initial?.name ?? '')
  const [command, setCommand] = useState(initial ? [initial.command, ...initial.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(' ') : '')
  const [env, setEnv] = useState(Object.entries(initial?.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'))
  const clash = taken.includes(name.trim().toLowerCase())
  const valid = name.trim() !== '' && !clash && splitArgs(command).length > 0

  const save = (): void => {
    const [bin, ...args] = splitArgs(command)
    onSave({ id: initial?.id ?? `acp_${Date.now().toString(36)}`, name: name.trim(), command: bin, args, env: parsePairs(env, /=/) })
  }

  return (
    <Card className="p-3.5">
      <label className="block">
        <span className="mb-1 block text-[11.5px] text-muted">Name</span>
        <TextInput autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Gemini CLI" />
        {clash && <span className="mt-1 block text-[11.5px] text-danger">Another agent already uses this name.</span>}
      </label>
      <label className="mt-2.5 block">
        <span className="mb-1 block text-[11.5px] text-muted">Command that starts the agent's ACP server on stdio</span>
        <TextInput value={command} onChange={(event) => setCommand(event.target.value)} placeholder="gemini --experimental-acp" className="font-mono text-[12px]" />
      </label>
      <label className="mt-2.5 block">
        <span className="mb-1 block text-[11.5px] text-muted">Environment variables, one KEY=value per line</span>
        <textarea
          value={env}
          onChange={(event) => setEnv(event.target.value)}
          rows={2}
          spellCheck={false}
          className="w-full resize-y rounded-md border border-line-strong bg-inset px-2.5 py-1.5 font-mono text-[12px] placeholder:text-subtle focus:border-fg/40"
          placeholder="API_KEY=..."
        />
      </label>
      <div className="mt-3 flex justify-end gap-1.5">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" disabled={!valid} onClick={save}>
          {initial ? 'Save changes' : 'Add agent'}
        </Button>
      </div>
    </Card>
  )
}

function CustomAcpSection({ off }: { off: boolean }): ReactNode {
  const settings = useStore((s) => s.settings)
  const agents = settings.customAcpAgents ?? []
  const statuses = useStore((s) => s.accountStatuses)
  const update = useStore((s) => s.updateSettings)
  const [editing, setEditing] = useState<string | 'new' | null>(null)

  const takenBy = (id: string | null): string[] => [
    'default',
    'local',
    'openrouter',
    'claude',
    'claude code',
    'codex',
    ...AcpAgents.filter((agent) => !agent.Custom).map((agent) => agent.DisplayName.toLowerCase()),
    ...agents.filter((agent) => agent.id !== id).map((agent) => agent.name.toLowerCase())
  ]

  const save = (agent: CustomAcpAgent): void => {
    const exists = agents.some((a) => a.id === agent.id)
    void update({
      customAcpAgents: exists ? agents.map((a) => (a.id === agent.id ? agent : a)) : [...agents, agent],
      ...(exists ? {} : { accounts: { ...settings.accounts, [agent.id]: { enabled: true, binaryPath: '' } } })
    })
    setEditing(null)
  }

  const remove = (id: string): void => {
    const accounts = { ...settings.accounts }
    delete accounts[id]
    void update({ customAcpAgents: agents.filter((a) => a.id !== id), accounts })
  }

  return (
    <Section
      title="Custom agents"
      description="Add any coding agent that speaks the Agent Client Protocol on stdio. Renaming an agent detaches the chats that used it."
      action={
        editing === null ? (
          <Button size="sm" disabled={off} onClick={() => setEditing('new')}>
            <Plus size={13} /> Add agent
          </Button>
        ) : null
      }
    >
      {editing === 'new' && (
        <div className="mb-3">
          <CustomAcpEditor initial={null} taken={takenBy(null)} onSave={save} onCancel={() => setEditing(null)} />
        </div>
      )}
      {agents.length === 0 && editing !== 'new' ? (
        <div className="rounded-xl border border-dashed border-line-strong px-4 py-8 text-center text-[12.5px] text-subtle">No custom agents yet.</div>
      ) : (
        <div className={cn('space-y-2', off && 'opacity-50')}>
          {agents.map((agent) => {
            if (editing === agent.id) return <CustomAcpEditor key={agent.id} initial={agent} taken={takenBy(agent.id)} onSave={save} onCancel={() => setEditing(null)} />
            const status = statuses?.find((s) => s.id === agent.id)
            const state = !status ? { text: 'Checking…', tone: 'text-subtle' } : status.installed ? { text: 'Installed', tone: 'text-ok' } : { text: 'Command not found', tone: 'text-warn' }
            const on = settings.accounts[agent.id]?.enabled !== false
            return (
              <Card key={agent.id}>
                <div className="flex items-center gap-3 px-3.5 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[12.5px] font-medium text-fg">{agent.name}</span>
                      <span className={cn('text-[11.5px]', state.tone)}>{state.text}</span>
                      {status?.version && <span className="font-mono text-[11px] text-subtle">v{status.version}</span>}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-subtle">{[agent.command, ...agent.args].join(' ')}</div>
                  </div>
                  <IconButton label="Edit" size="sm" disabled={off} onClick={() => setEditing(agent.id)}>
                    <Pencil size={12.5} />
                  </IconButton>
                  <IconButton label="Remove" size="sm" disabled={off} onClick={() => remove(agent.id)}>
                    <Trash2 size={12.5} />
                  </IconButton>
                  <Switch
                    checked={on}
                    disabled={off}
                    onChange={(enabled) => void update({ accounts: { ...settings.accounts, [agent.id]: { binaryPath: settings.accounts[agent.id]?.binaryPath ?? '', enabled } } })}
                    label={`Enable ${agent.name}`}
                  />
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </Section>
  )
}

// MCP

function splitArgs(line: string): string[] {
  const out: string[] = []
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(line))) out.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : (match[2] ?? match[3]))
  return out
}

function parsePairs(text: string, separator: RegExp): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const index = trimmed.search(separator)
    if (index <= 0) continue
    out[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim()
  }
  return out
}

function McpEditor({ initial, onSave, onCancel }: { initial: McpServerConfig | null; onSave(config: McpServerConfig): void; onCancel(): void }): ReactNode {
  const [name, setName] = useState(initial?.name ?? '')
  const [transport, setTransport] = useState<'stdio' | 'http'>(initial?.transport ?? 'stdio')
  const [command, setCommand] = useState(initial ? [initial.command ?? '', ...(initial.args ?? []).map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(' ').trim() : '')
  const [env, setEnv] = useState(Object.entries(initial?.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'))
  const [url, setUrl] = useState(initial?.url ?? '')
  const [headers, setHeaders] = useState(Object.entries(initial?.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'))
  const valid = name.trim() !== '' && (transport === 'stdio' ? command.trim() !== '' : /^https?:\/\//.test(url.trim()))

  const save = (): void => {
    const [bin, ...args] = splitArgs(command)
    onSave({
      id: initial?.id ?? `mcp_${Date.now().toString(36)}`,
      name: name.trim(),
      enabled: initial?.enabled ?? true,
      transport,
      ...(transport === 'stdio' ? { command: bin, args, env: parsePairs(env, /=/) } : { url: url.trim(), headers: parsePairs(headers, /:/) })
    })
  }

  return (
    <Card className="p-3.5">
      <div className="flex gap-2">
        <label className="block flex-1">
          <span className="mb-1 block text-[11.5px] text-muted">Name</span>
          <TextInput autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="github" />
        </label>
        <div>
          <span className="mb-1 block text-[11.5px] text-muted">Transport</span>
          <Segmented<'stdio' | 'http'> value={transport} onChange={setTransport} options={[{ value: 'stdio', label: 'Command' }, { value: 'http', label: 'HTTP' }]} />
        </div>
      </div>
      {transport === 'stdio' ? (
        <>
          <label className="mt-2.5 block">
            <span className="mb-1 block text-[11.5px] text-muted">Command</span>
            <TextInput value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx -y @modelcontextprotocol/server-filesystem ~/Documents" className="font-mono text-[12px]" />
          </label>
          <label className="mt-2.5 block">
            <span className="mb-1 block text-[11.5px] text-muted">Environment variables, one KEY=value per line</span>
            <textarea
              value={env}
              onChange={(event) => setEnv(event.target.value)}
              rows={2}
              spellCheck={false}
              className="w-full resize-y rounded-md border border-line-strong bg-inset px-2.5 py-1.5 font-mono text-[12px] placeholder:text-subtle focus:border-fg/40"
              placeholder="API_TOKEN=..."
            />
          </label>
        </>
      ) : (
        <>
          <label className="mt-2.5 block">
            <span className="mb-1 block text-[11.5px] text-muted">URL</span>
            <TextInput value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" className="font-mono text-[12px]" />
          </label>
          <label className="mt-2.5 block">
            <span className="mb-1 block text-[11.5px] text-muted">Headers, one Name: value per line</span>
            <textarea
              value={headers}
              onChange={(event) => setHeaders(event.target.value)}
              rows={2}
              spellCheck={false}
              className="w-full resize-y rounded-md border border-line-strong bg-inset px-2.5 py-1.5 font-mono text-[12px] placeholder:text-subtle focus:border-fg/40"
              placeholder="Authorization: Bearer ..."
            />
          </label>
        </>
      )}
      <div className="mt-3 flex justify-end gap-1.5">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" disabled={!valid} onClick={save}>
          {initial ? 'Save changes' : 'Add server'}
        </Button>
      </div>
    </Card>
  )
}

function McpSection(): ReactNode {
  const servers = useStore((s) => s.settings.mcpServers)
  const statuses = useStore((s) => s.mcp)
  const update = useStore((s) => s.updateSettings)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const save = (config: McpServerConfig): void => {
    const exists = servers.some((s) => s.id === config.id)
    void update({ mcpServers: exists ? servers.map((s) => (s.id === config.id ? config : s)) : [...servers, config] })
    setEditing(null)
  }

  return (
    <Section
      title="MCP servers"
      description="Connect tools and data through the Model Context Protocol. Servers are available to every engine; account CLIs also keep any servers from their own config."
      action={
        editing === null ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus size={13} /> Add server
          </Button>
        ) : null
      }
    >
      {editing === 'new' && (
        <div className="mb-3">
          <McpEditor initial={null} onSave={save} onCancel={() => setEditing(null)} />
        </div>
      )}
      {servers.length === 0 && editing !== 'new' ? (
        <div className="rounded-xl border border-dashed border-line-strong px-4 py-8 text-center text-[12.5px] text-subtle">No MCP servers yet.</div>
      ) : (
        <div className="space-y-2">
          {servers.map((server) => {
            const status = statuses.find((s) => s.id === server.id)
            if (editing === server.id) return <McpEditor key={server.id} initial={server} onSave={save} onCancel={() => setEditing(null)} />
            const state = !server.enabled ? 'disabled' : (status?.state ?? 'connecting')
            return (
              <Card key={server.id}>
                <div className="flex items-center gap-3 px-3.5 py-2.5">
                  <span
                    className={cn(
                      'h-[7px] w-[7px] shrink-0 rounded-full',
                      state === 'ready' ? 'bg-ok' : state === 'error' ? 'bg-danger' : state === 'connecting' ? 'bg-warn' : 'bg-line-strong'
                    )}
                  />
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setExpanded(expanded === server.id ? null : server.id)}>
                    <div className="flex items-center gap-2">
                      <span className="text-[12.5px] font-medium text-fg">{server.name}</span>
                      <span className="text-[11.5px] text-muted">
                        {state === 'ready' ? `${status?.tools.length ?? 0} tools` : state === 'error' ? 'Failed to connect' : state === 'connecting' ? 'Connecting…' : 'Off'}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-subtle">
                      {server.transport === 'stdio' ? [server.command, ...(server.args ?? [])].join(' ') : server.url}
                    </div>
                  </button>
                  {server.enabled && (
                    <IconButton label="Reconnect" size="sm" onClick={() => void window.galaxy.mcp.reconnect(server.id)}>
                      <RefreshCw size={12.5} />
                    </IconButton>
                  )}
                  <IconButton label="Edit" size="sm" onClick={() => setEditing(server.id)}>
                    <Pencil size={12.5} />
                  </IconButton>
                  <IconButton label="Remove" size="sm" onClick={() => void update({ mcpServers: servers.filter((s) => s.id !== server.id) })}>
                    <Trash2 size={12.5} />
                  </IconButton>
                  <Switch
                    checked={server.enabled}
                    onChange={(enabled) => void update({ mcpServers: servers.map((s) => (s.id === server.id ? { ...s, enabled } : s)) })}
                    label={`Enable ${server.name}`}
                  />
                </div>
                {state === 'error' && status?.error && <div className="selectable px-3.5 py-2 font-mono text-[11.5px] text-danger">{status.error}</div>}
                {expanded === server.id && status && status.tools.length > 0 && (
                  <div className="space-y-1.5 px-3.5 py-2.5">
                    {status.tools.map((tool) => (
                      <div key={tool.name} className="text-[12px]">
                        <span className="font-mono text-fg">{tool.name}</span>
                        {tool.description && <span className="ml-2 text-muted">{tool.description.split('\n')[0].slice(0, 140)}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}
    </Section>
  )
}

// Skills

function SkillsSection(): ReactNode {
  const homeDir = useStore((s) => s.homeDir)
  const projects = useStore((s) => s.projects)
  const activeProjectId = useStore((s) => (s.activeChatId ? (s.chats[s.activeChatId]?.projectId ?? null) : s.draft.projectId))
  const openFile = useStore((s) => s.openFile)
  const [projectId, setProjectId] = useState<string | null>(activeProjectId)
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const project = projects.find((p) => p.id === projectId) ?? null

  const load = useCallback(() => {
    void window.galaxy.skills.list(projectId).then(setSkills)
  }, [projectId])
  useEffect(load, [load])

  const memoryFile = `${homeDir}/.galaxy/MEMORY.md`
  const grouped = useMemo(
    () => ({ project: (skills ?? []).filter((s) => s.scope === 'project'), user: (skills ?? []).filter((s) => s.scope === 'user') }),
    [skills]
  )

  const list = (items: SkillInfo[]): ReactNode =>
    items.length === 0 ? (
      <div className="px-3.5 py-3 text-[12px] text-subtle">None found.</div>
    ) : (
      items.map((skill) => (
        <button
          key={skill.path}
          type="button"
          className="flex w-full items-start gap-3 px-3.5 py-2.5 text-left"
          onClick={() => {
            openFile(skill.path)
            useStore.setState({ settingsOpen: null })
          }}
        >
          <Box size={13.5} className="mt-[2px] shrink-0 text-muted" />
          <span className="min-w-0 flex-1">
            <span className="block text-[12.5px] text-fg">{skill.name}</span>
            {skill.description && <span className="block text-[11.5px] leading-snug text-muted">{skill.description}</span>}
          </span>
        </button>
      ))
    )

  return (
    <>
      <Section
        title="Skills"
        description={
          <>
            A skill is a folder with a <span className="font-mono">SKILL.md</span> that teaches the agent how to do one kind of task. The agent sees each skill's name and
            description, and reads the file when a task calls for it.
          </>
        }
        action={
          <div className="flex items-center gap-1.5">
            {projects.length > 0 && (
              <Select
                label="Project"
                value={projectId ?? ''}
                onChange={(value) => setProjectId(value || null)}
                className="max-w-[160px]"
                options={[{ value: '', label: 'No project' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
              />
            )}
            <IconButton label="Rescan" onClick={load}>
              <RefreshCw size={13} />
            </IconButton>
          </div>
        }
      >
        <div className="space-y-3">
          <div>
            <div className="mb-1 flex items-center justify-between px-1">
              <span className="font-mono text-[11px] text-subtle">~/.galaxy/skills</span>
              <button type="button" className="text-[11.5px] text-link hover:underline" onClick={() => void window.galaxy.skills.openFolder('user', null)}>
                Open folder
              </button>
            </div>
            <Card>{list(grouped.user)}</Card>
          </div>
          {project && (
            <div>
              <div className="mb-1 flex items-center justify-between px-1">
                <span className="font-mono text-[11px] text-subtle">{project.name}/.galaxy/skills</span>
                <button type="button" className="text-[11.5px] text-link hover:underline" onClick={() => void window.galaxy.skills.openFolder('project', project.id)}>
                  Open folder
                </button>
              </div>
              <Card>{list(grouped.project)}</Card>
            </div>
          )}
        </div>
      </Section>
      <Section title="Memory" description="Notes the agent keeps between chats. It updates this file with the Memory tool; you can edit it by hand too.">
        <Card>
          <RowItem label="Memory" hint={<span className="font-mono">{tildify(memoryFile, homeDir)}</span>}>
            <Button
              size="sm"
              onClick={() => {
                openFile(memoryFile)
                useStore.setState({ settingsOpen: null })
              }}
            >
              Open
            </Button>
          </RowItem>
        </Card>
      </Section>
    </>
  )
}

export function SettingsPage(): ReactNode {
  const section = useStore((s) => s.settingsOpen)
  const platform = useStore((s) => s.platform)
  const close = useCallback(() => useStore.setState({ settingsOpen: null }), [])
  useEffect(() => {
    if (!section) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !document.querySelector('[role="dialog"], [role="alertdialog"]')) close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [section, close])
  if (!section) return null
  return (
    <div className="fixed inset-0 z-30 flex bg-sidebar text-fg">
      <nav className="flex w-[232px] shrink-0 flex-col gap-0.5 px-2.5 pb-3">
        <div className={cn('drag h-[46px] shrink-0', platform === 'darwin' && 'ml-[74px]')} />
        <button
          type="button"
          onClick={close}
          className="no-drag mb-3 flex h-[30px] items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <ArrowLeft size={14} />
          Back to app
        </button>
        {SECTIONS.map((entry) => {
          const Icon = entry.icon
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => useStore.setState({ settingsOpen: entry.id })}
              className={cn(
                'flex h-[30px] items-center gap-2 rounded-md px-2 text-left text-[12.5px] transition-colors',
                section === entry.id ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg'
              )}
            >
              <Icon size={14} />
              {entry.label}
            </button>
          )
        })}
      </nav>
      <main className="my-1.5 mr-1.5 min-w-0 flex-1 overflow-hidden rounded-xl bg-bg shadow-[0_0_0_1px_var(--border)]">
        <div className="h-full overflow-y-auto">
          <div className="mx-auto w-full max-w-[720px] px-8 pb-12 pt-10">
            <h2 className="mb-6 text-[19px] font-semibold text-fg">{SECTIONS.find((entry) => entry.id === section)?.label}</h2>
            {section === 'general' && <GeneralSection />}
            {section === 'models' && <ModelsSection />}
            {section === 'providers' && <ProvidersSection />}
            {section === 'accounts' && <AccountsSection />}
            {section === 'usage' && <UsageSection />}
            {section === 'acp' && <AcpSection />}
            {section === 'mcp' && <McpSection />}
            {section === 'skills' && <SkillsSection />}
          </div>
        </div>
      </main>
    </div>
  )
}

export { cleanError }
