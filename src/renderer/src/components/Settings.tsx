import {
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
  Sparkles,
  Trash2,
  UserRound,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode, type SelectHTMLAttributes } from 'react'
import {
  ACCOUNT_LABELS,
  ACP_ACCOUNTS,
  KEYLESS_ACCOUNTS,
  SUBSCRIPTIONS,
  acpAgentFor,
  accountSubscription,
  type AccountId,
  type McpServerConfig,
  type PermissionMode,
  type SkillInfo,
  type Subscription,
  type ThemeMode
} from '@shared/types'
import { AcpAgents } from '@shared/acp-registry'
import { cn, tildify } from '../lib/utils'
import { useStore, type SettingsSection } from '../store'
import { SUBSCRIPTION_LABELS } from './ModelPicker'
import { Button, IconButton, Modal, Segmented, Spinner, Switch, TextInput } from './ui'

const SECTIONS: { id: SettingsSection; label: string; icon: typeof Cpu }[] = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'models', label: 'Models', icon: Boxes },
  { id: 'providers', label: 'Providers', icon: KeyRound },
  { id: 'accounts', label: 'AI accounts', icon: UserRound },
  { id: 'acp', label: 'ACP agents', icon: Cable },
  { id: 'mcp', label: 'MCP servers', icon: Plug },
  { id: 'skills', label: 'Skills & memory', icon: Sparkles }
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

function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>): ReactNode {
  return (
    <select
      className={cn('h-7.5 max-w-[240px] rounded-md border border-line-strong bg-inset px-2 text-[12.5px] text-fg focus:border-fg/40', className)}
      {...rest}
    >
      {children}
    </select>
  )
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
  const autoModel = useStore((s) => s.autoApprovalModel)
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
        </Card>
      </Section>
      <Section title="Permissions" description="How new chats start. You can change the mode for any chat from the message box.">
        <Card>
          <RowItem label="Default permission mode">
            <Select value={settings.defaultPermissionMode} onChange={(event) => void update({ defaultPermissionMode: event.target.value as PermissionMode })}>
              <option value="auto">Auto</option>
              <option value="ask">Ask for approval</option>
              <option value="full">Full access</option>
            </Select>
          </RowItem>
          <RowItem
            label="Auto approval model"
            hint="Auto reviews each action with Luna Decisions. A deny probability of 50% or more asks for your approval in the message box. It needs an OpenRouter key."
          >
            <span className="shrink-0 font-mono text-[11.5px] text-muted">{autoModel.id}</span>
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
  const [name, setName] = useState('')
  const [id, setId] = useState('')
  const [subscription, setSubscription] = useState<Subscription>('Default')

  const toggle = (key: string, enabled: boolean): void => {
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
  }

  const remove = (modelId: string, sub: Subscription): void => {
    void update({
      customModels: settings.customModels.filter((m) => !(m.id === modelId && m.subscription === sub)),
      disabledModels: settings.disabledModels.filter((key) => key !== `${sub}:${modelId}`)
    })
  }

  const groups = MODEL_SUBSCRIPTIONS.map((sub) => ({ sub, models: models.filter((m) => m.subscription === sub) })).filter((g) => g.models.length > 0)
  const imageKey = imageModels.some((m) => m.key === settings.imageModelKey) ? (settings.imageModelKey as string) : (imageModels[0]?.key ?? '')

  return (
    <>
      <Section title="Image generation" description="The model the ImageGeneration tool uses.">
        <Card>
          <RowItem label="Image Generation Model">
            <Select value={imageKey} onChange={(event) => void update({ imageModelKey: event.target.value })}>
              {imageModels.map((model) => (
                <option key={model.key} value={model.key}>
                  {model.name}
                </option>
              ))}
            </Select>
          </RowItem>
        </Card>
      </Section>

      <Section title="Agent models" description="Turn a model off to hide it from the model picker.">
        <div className="space-y-3">
          {groups.map((group) => (
            <div key={group.sub}>
              <div className="mb-1 px-1 text-[11px] font-medium text-subtle">{SUBSCRIPTION_LABELS[group.sub]}</div>
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

      <Section title="Add a custom model" description="Use any model id your subscription or OpenRouter accepts.">
        <Card className="p-3.5">
          <div className="grid grid-cols-[1fr_1.3fr_auto] gap-2">
            <label className="block">
              <span className="mb-1 block text-[11.5px] text-muted">Name</span>
              <TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder="Display name" />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11.5px] text-muted">Model ID</span>
              <TextInput
                value={id}
                onChange={(event) => setId(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') add()
                }}
                placeholder="vendor/model-name"
                className="font-mono text-[12px]"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11.5px] text-muted">Subscription</span>
              <Select value={subscription} onChange={(event) => setSubscription(event.target.value as Subscription)} className="w-[150px]">
                {MODEL_SUBSCRIPTIONS.map((sub) => (
                  <option key={sub} value={sub}>
                    {sub === 'Default' ? 'Default (OpenRouter)' : SUBSCRIPTION_LABELS[sub]}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          <div className="mt-3 flex justify-end">
            <Button variant="primary" size="sm" disabled={!id.trim()} onClick={add}>
              <Plus size={13} /> Add model
            </Button>
          </div>
        </Card>
      </Section>
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
  return (
    <>
      <Section
        title="ACP agents"
        description="Coding agents that Galaxy Code reaches over the Agent Client Protocol. Each agent reports its own models and modes, which the composer shows in place of the model picker. Agents are listed in src/shared/acp-registry.ts."
      >
        <Card>
          <RowItem label="Use ACP agents" hint="Turns every agent below on or off at once. Each agent keeps its own switch.">
            <Switch checked={enabled} onChange={(acpEnabled) => void update({ acpEnabled })} label="Use ACP agents" />
          </RowItem>
        </Card>
      </Section>
      <Section title="Agents" action={<RefreshAccountsButton />}>
        <AccountList ids={ACP_ACCOUNTS} off={!enabled} />
      </Section>
    </>
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

  const memoryFile = `${project ? project.path : homeDir}/.galaxy/MEMORY.md`
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
          className="flex w-full items-start gap-3 px-3.5 py-2.5 text-left hover:bg-hover"
          onClick={() => {
            openFile(skill.path)
            useStore.setState({ settingsOpen: null })
          }}
        >
          <Sparkles size={13.5} className="mt-[2px] shrink-0 text-muted" />
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
              <Select value={projectId ?? ''} onChange={(event) => setProjectId(event.target.value || null)} className="max-w-[160px]">
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
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
          <RowItem label={project ? `${project.name} memory` : 'Global memory'} hint={<span className="font-mono">{tildify(memoryFile, homeDir)}</span>}>
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

export function SettingsModal(): ReactNode {
  const section = useStore((s) => s.settingsOpen)
  const close = useCallback(() => useStore.setState({ settingsOpen: null }), [])
  if (!section) return null
  return (
    <Modal onClose={close} className="flex h-[640px] w-[860px] max-w-full">
      <nav className="flex w-[196px] shrink-0 flex-col gap-0.5 border-r border-line bg-sidebar p-2.5">
        <div className="mb-1 px-2 pb-1 pt-1.5 text-[12px] font-semibold text-fg">Settings</div>
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
      <div className="relative min-w-0 flex-1">
        <IconButton label="Close" className="absolute right-3 top-3 z-10" onClick={close}>
          <X size={15} />
        </IconButton>
        <div className="h-full overflow-y-auto px-7 py-6">
          {section === 'general' && <GeneralSection />}
          {section === 'models' && <ModelsSection />}
          {section === 'providers' && <ProvidersSection />}
          {section === 'accounts' && <AccountsSection />}
          {section === 'acp' && <AcpSection />}
          {section === 'mcp' && <McpSection />}
          {section === 'skills' && <SkillsSection />}
        </div>
      </div>
    </Modal>
  )
}

export { cleanError }
