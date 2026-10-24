import { AcpAgents } from './acp-registry'
import { AgentModel, ImageModel, type AgentModelSpec, type Effort } from './models'
import { ACP_ACCOUNTS, KEYLESS_ACCOUNTS, SUBSCRIPTION_ACCOUNT, SUBSCRIPTIONS, type AccountId, type AccountStatus, type CustomModel, type ResolvedImageModel, type ResolvedModel, type Settings, type Subscription } from './types'

const EFFORT_ORDER: Effort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function modelKey(subscription: string, id: string): string {
  return `${subscription}:${id}`
}

/** Existing chats stay within the native engines or their original ACP agent. */
export function canUseChatSubscription(chat: { modelKey: string; initialSubscription?: Subscription } | null | undefined, subscription: Subscription): boolean {
  if (!chat) return true
  const initial = chat.initialSubscription ?? chat.modelKey.split(':', 1)[0]
  return initial === subscription
}

function pickDefaultEffort(spec: AgentModelSpec): Effort | null {
  if (spec.Efforts.length === 0) return null
  if (spec.DefaultEffort && spec.Efforts.includes(spec.DefaultEffort)) return spec.DefaultEffort
  return spec.Efforts[Math.floor((spec.Efforts.length - 1) / 2)]
}

function fromSpec(spec: AgentModelSpec, disabled: Set<string>, enabled: Set<string>): ResolvedModel {
  const key = modelKey(spec.Subscription, spec.ID)
  const efforts = [...spec.Efforts].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))
  return {
    key,
    name: spec.DisplayName,
    id: spec.ID,
    subscription: spec.Subscription,
    efforts,
    defaultEffort: pickDefaultEffort(spec),
    ultraEffort: spec.UltraEffort === '' ? null : spec.UltraEffort,
    fastMode: spec.FastMode,
    vision: spec.Vision !== false,
    custom: false,
    enabled: spec.Off ? enabled.has(key) : !disabled.has(key),
    defaultOff: spec.Off === true
  }
}

function fromCustom(model: CustomModel, disabled: Set<string>): ResolvedModel {
  const key = modelKey(model.subscription, model.id)
  return {
    key,
    name: model.name,
    id: model.id,
    subscription: model.subscription,
    efforts: [],
    defaultEffort: null,
    ultraEffort: null,
    fastMode: false,
    vision: true,
    custom: true,
    enabled: !disabled.has(key)
  }
}

/** OpenRouter's Auto Router: it chooses a model for each request, so it has no effort or Fast. */
export const AUTO_MODEL: ResolvedModel = {
  key: modelKey('Default', 'openrouter/auto'),
  name: 'Auto',
  id: 'openrouter/auto',
  subscription: 'Default',
  efforts: [],
  defaultEffort: null,
  ultraEffort: null,
  fastMode: false,
  vision: true,
  custom: false,
  enabled: true,
  auto: true
}

/** ACP agents pick their model inside the session, so each gets one entry that stands for the agent. */
function fromAcpAgent(name: string): ResolvedModel {
  return {
    key: modelKey(name, ACP_MODEL_ID),
    name,
    id: ACP_MODEL_ID,
    subscription: name,
    efforts: [],
    defaultEffort: null,
    ultraEffort: null,
    fastMode: false,
    vision: true,
    custom: false,
    enabled: true
  }
}

/** The model id of an ACP agent's entry. The agent's own config options choose the real model. */
export const ACP_MODEL_ID = 'default'

export function resolveModels(settings: Pick<Settings, 'customModels' | 'disabledModels' | 'enabledModels'>): ResolvedModel[] {
  const disabled = new Set(settings.disabledModels)
  const enabled = new Set(settings.enabledModels ?? [])
  const seen = new Set<string>()
  const out: ResolvedModel[] = []
  for (const model of [
    AUTO_MODEL,
    ...AgentModel.map((spec) => fromSpec(spec, disabled, enabled)),
    ...AcpAgents.map((agent) => fromAcpAgent(agent.DisplayName)),
    ...settings.customModels.filter((custom) => !ACP_ACCOUNTS.includes(SUBSCRIPTION_ACCOUNT[custom.subscription] ?? '')).map((custom) => fromCustom(custom, disabled))
  ]) {
    if (seen.has(model.key)) continue
    seen.add(model.key)
    out.push(model)
  }
  return out
}

export function resolveImageModels(): ResolvedImageModel[] {
  return ImageModel.map((spec) => ({
    key: modelKey(spec.Subscription, spec.ID),
    name: spec.DisplayName,
    id: spec.ID,
    subscription: spec.Subscription
  }))
}

export function findModel(models: ResolvedModel[], key: string | null | undefined): ResolvedModel | null {
  if (!key) return null
  return models.find((m) => m.key === key) ?? null
}

/** An account is usable only when its own switch is on, and for ACP agents the ACP switch too. */
export function accountEnabled(settings: Pick<Settings, 'accounts' | 'acpEnabled'>, id: AccountId): boolean {
  if (settings.accounts[id]?.enabled === false) return false
  return settings.acpEnabled !== false || !ACP_ACCOUNTS.includes(id)
}

/** Local uses the native engine. Account subscriptions require confirmed sign-in, except keyless ones. */
export function availableSubscriptions(settings: Pick<Settings, 'accounts' | 'acpEnabled'>, statuses: AccountStatus[]): Subscription[] {
  return SUBSCRIPTIONS.filter((subscription) => {
    if (subscription === 'Default') return true
    const id = SUBSCRIPTION_ACCOUNT[subscription]
    return accountEnabled(settings, id) && statuses.some((status) => status.id === id && status.installed && (status.authenticated === true || KEYLESS_ACCOUNTS.includes(id)))
  })
}

/** The model a new chat starts on: the saved default if still usable, else the first enabled one. */
export function defaultModel(models: ResolvedModel[], preferred: string | null): ResolvedModel | null {
  const saved = findModel(models, preferred)
  if (saved?.enabled) return saved
  return models.find((m) => m.enabled) ?? models[0] ?? null
}

/** Clamp a stored effort to what the model supports. */
export function normalizeEffort(model: ResolvedModel, effort: Effort | null): Effort | null {
  if (model.efforts.length === 0) return null
  if (effort && model.efforts.includes(effort)) return effort
  return model.defaultEffort
}

/** The effort a request actually runs at, accounting for Ultra. */
export function effectiveEffort(model: ResolvedModel, effort: Effort | null, ultra: boolean): Effort | null {
  if (ultra && model.ultraEffort) return model.ultraEffort
  return normalizeEffort(model, effort)
}
