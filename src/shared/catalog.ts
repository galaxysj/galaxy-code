import { AcpAgents } from './acp-registry'
import { AgentModel, AutoTiers, ImageModel, type AgentModelSpec, type Effort } from './models'
import { ACP_ACCOUNTS, SUBSCRIPTION_ACCOUNT, SUBSCRIPTIONS, type AccountId, type AccountStatus, type AutoRouterSettings, type CustomModel, type ResolvedImageModel, type ResolvedModel, type SecretState, type Settings, type Subscription } from './types'

const EFFORT_ORDER: Effort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** A built-in provider, or a CustomProvider's generated id. */
export type ProviderId = 'openai' | 'anthropic' | 'google' | 'xai' | 'deepseek' | 'meta' | (string & {})

export interface ByokProvider {
  id: ProviderId
  name: string
  /** The start of this provider's model ids in models.ts. */
  prefix: string
  /** Its OpenAI-compatible API. */
  baseUrl: string
  keysUrl: string
  placeholder: string
  /** Reasoning efforts its API takes, lowest to highest. Unset sends none. */
  efforts?: Effort[]
}

/** Providers a user can bring their own key for. A saved key sends that provider's models straight to it instead of OpenRouter. */
export const BYOK_PROVIDERS: ByokProvider[] = [
  { id: 'openai', name: 'OpenAI', prefix: 'openai/', baseUrl: 'https://api.openai.com/v1', keysUrl: 'https://platform.openai.com/api-keys', placeholder: 'sk-…', efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'anthropic', name: 'Anthropic', prefix: 'anthropic/', baseUrl: 'https://api.anthropic.com/v1', keysUrl: 'https://console.anthropic.com/settings/keys', placeholder: 'sk-ant-…' },
  { id: 'google', name: 'Google', prefix: 'google/', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keysUrl: 'https://aistudio.google.com/apikey', placeholder: 'AIza…', efforts: ['none', 'low', 'medium', 'high'] },
  { id: 'xai', name: 'xAI', prefix: 'x-ai/', baseUrl: 'https://api.x.ai/v1', keysUrl: 'https://console.x.ai', placeholder: 'xai-…' },
  { id: 'deepseek', name: 'DeepSeek', prefix: 'deepseek/', baseUrl: 'https://api.deepseek.com/v1', keysUrl: 'https://platform.deepseek.com/api_keys', placeholder: 'sk-…' },
  { id: 'meta', name: 'Meta', prefix: 'meta/', baseUrl: 'https://api.llama.com/compat/v1', keysUrl: 'https://llama.developer.meta.com', placeholder: 'LLM|…' }
]

export function byokProvider(modelId: string): ByokProvider | null {
  return BYOK_PROVIDERS.find((provider) => modelId.startsWith(provider.prefix)) ?? null
}

/** The id the provider's own API knows a model by. Anthropic writes versions with dashes, as in claude-opus-5-5. */
export function directModelId(provider: ByokProvider, modelId: string): string {
  const id = modelId.slice(provider.prefix.length)
  return provider.id === 'anthropic' ? id.replace(/\./g, '-') : id
}

/** The strongest effort the provider takes that does not exceed the one asked for. */
export function directEffort(provider: Pick<ByokProvider, 'efforts'>, effort: Effort): Effort | null {
  const levels = provider.efforts ?? []
  const rank = EFFORT_ORDER.indexOf(effort)
  return levels.filter((level) => EFFORT_ORDER.indexOf(level) <= rank).at(-1) ?? levels[0] ?? null
}

const CUSTOM_PREFIX = 'custom/'

export function customModelId(providerId: string, model: string): string {
  return `${CUSTOM_PREFIX}${providerId}/${model}`
}

/** Splits a custom provider's model id; null for every other model. */
export function parseCustomModel(modelId: string): { providerId: string; model: string } | null {
  if (!modelId.startsWith(CUSTOM_PREFIX)) return null
  const slash = modelId.indexOf('/', CUSTOM_PREFIX.length)
  return slash < 0 ? null : { providerId: modelId.slice(CUSTOM_PREFIX.length, slash), model: modelId.slice(slash + 1) }
}

/** Whether a Default model can run: on OpenRouter's key, or on the key for its own provider while that is switched on. Custom providers may need no key. */
export function hasModelKey(secrets: SecretState, settings: Pick<Settings, 'disabledProviders'>, modelId: string): boolean {
  if (parseCustomModel(modelId)) return true
  const provider = byokProvider(modelId)
  return secrets.openRouterKey || (!!provider && !!secrets.providerKeys[provider.id] && !settings.disabledProviders.includes(provider.id))
}

/** Whether a model id is Auto itself or a model marked Free in models.ts. Both run without credits and count toward the Auto usage. */
export function isAutoId(id: string): boolean {
  return id === 'openrouter/free' || AgentModel.some((m) => m.ID === id && m.Free === true)
}

/** Whether a model runs on OpenRouter credits. Auto is free, and accounts, custom providers and models on their own provider's key pay elsewhere. */
export function needsCredits(model: Pick<ResolvedModel, 'id' | 'subscription'>, secrets: SecretState, settings: Pick<Settings, 'disabledProviders'>): boolean {
  if (model.subscription !== 'Default' || isAutoId(model.id) || parseCustomModel(model.id)) return false
  const provider = byokProvider(model.id)
  return !provider || !secrets.providerKeys[provider.id] || settings.disabledProviders.includes(provider.id)
}

export function modelKey(subscription: string, id: string): string {
  return `${subscription}:${id}`
}

/** Whether Galaxy Code's own engine and tools run the subscription: its own models, and Codex on the ChatGPT login. */
export function usesGalaxyTools(subscription: Subscription | null | undefined): boolean {
  return subscription === 'Default' || subscription === 'Codex'
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
    brand: spec.Brand,
    id: spec.ID,
    subscription: spec.Subscription,
    efforts,
    defaultEffort: pickDefaultEffort(spec),
    ultraEffort: spec.UltraEffort === '' ? null : spec.UltraEffort,
    fastMode: spec.FastMode,
    ultrafastMode: spec.FastMode && spec.UltrafastMode === true,
    vision: spec.Vision !== false,
    custom: false,
    enabled: spec.Off ? enabled.has(key) : !disabled.has(key),
    defaultOff: spec.Off === true,
    ...(spec.ContextWindow ? { contextWindow: spec.ContextWindow } : {}),
    ...(spec.DefaultSpeed ? { defaultSpeed: spec.DefaultSpeed } : {}),
    ...(spec.ContextOptions?.length ? { contextOptions: spec.ContextOptions } : {})
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
    ultrafastMode: false,
    vision: true,
    custom: true,
    enabled: !disabled.has(key)
  }
}

/** OpenRouter's Free Models Router: it sends each request to a free model, so it has no effort or Fast. */
export const AUTO_MODEL: ResolvedModel = {
  key: modelKey('Default', 'openrouter/free'),
  name: 'Auto',
  id: 'openrouter/free',
  subscription: 'Default',
  efforts: [],
  defaultEffort: null,
  ultraEffort: null,
  fastMode: false,
  ultrafastMode: false,
  vision: true,
  custom: false,
  enabled: true,
  auto: true,
  description: 'Sends each request to a free model on OpenRouter.'
}

/** OpenRouter's Auto Router, offered as a Premium check under Auto. Its key is the one Auto had before. */
export const PREMIUM_MODEL: ResolvedModel = {
  ...AUTO_MODEL,
  key: modelKey('Default', 'openrouter/auto'),
  name: 'Premium',
  id: 'openrouter/auto',
  description: 'Picks the best model for each request automatically.'
}

/** Prefix of a tier's id. The id after it names a stop in AutoTiers, and the request goes to openrouter/auto limited to that stop's models. */
export const AUTO_TIER_PREFIX = 'openrouter/auto:'

/** The picker stop for Free. It is not a router tier: it sends to OpenRouter's free router. */
export const AUTO_FREE_STOP = 'free'

/** Every stop Auto's picker can show, in order: Free, then the AutoTiers. */
export const AUTO_STOP_IDS: string[] = [AUTO_FREE_STOP, ...AutoTiers.map((tier) => tier.ID)]

/** Display names for the routable models. The '-latest' aliases are OpenRouter's, and each names the model it currently points at. */
const ROUTABLE_NAMES: Record<string, string> = {
  '~anthropic/claude-haiku-latest': 'Claude Haiku Latest',
  '~anthropic/claude-sonnet-latest': 'Claude Sonnet Latest',
  '~anthropic/claude-opus-latest': 'Claude Opus Latest',
  '~anthropic/claude-fable-latest': 'Claude Fable Latest',
  '~openai/gpt-luna-latest': 'GPT Luna Latest',
  '~openai/gpt-terra-latest': 'GPT Terra Latest',
  '~openai/gpt-sol-latest': 'GPT Sol Latest',
  '~openai/gpt-astra-latest': 'GPT Astra Latest',
  '~z-ai/glm-flash-latest': 'GLM Flash Latest',
  '~z-ai/glm-latest': 'GLM Latest',
  '~deepseek/deepseek-flash-latest': 'DeepSeek Flash Latest',
  '~deepseek/deepseek-pro-latest': 'DeepSeek Pro Latest',
  '~google/gemini-flash-latest': 'Gemini Flash Latest',
  '~google/gemini-pro-latest': 'Gemini Pro Latest',
  '~moonshotai/kimi-latest': 'Kimi Latest',
  'meta/muse-spark-1.3': 'Muse Spark 1.3',
  'meta/muse-wonder': 'Muse Wonder',
  'moonshotai/kimi-k3.1-pro': 'Kimi K3.1 Pro'
}

/** The name of a routable model, or its id when it has none. */
export function routableModelName(id: string): string {
  return ROUTABLE_NAMES[id] ?? id
}

/** Whether a routable model is a '-latest' alias, which the Auto router lists first. */
export function isLatestAlias(id: string): boolean {
  return id.includes('-latest')
}

/** The tier whose AutoTiers defaults name a '-latest' alias. Each alias belongs to that one tier only. */
export function latestOwner(id: string): string | undefined {
  return AutoTiers.find((tier) => tier.Models.includes(id))?.ID
}

/** A tier's routable models: its saved list without other tiers' '-latest' aliases, or its defaults when nothing usable is saved. */
function routesOf(tierId: string, saved: string[] | undefined): string[] {
  const own = (saved ?? []).filter((id) => !isLatestAlias(id) || latestOwner(id) === tierId)
  return own.length ? own : [...(AutoTiers.find((tier) => tier.ID === tierId)?.Models ?? [])]
}

/** Auto's router settings as they were shipped: every stop shown, each tier with its AutoTiers models. */
export function defaultAutoRouter(): AutoRouterSettings {
  return { tiers: [...AUTO_STOP_IDS], tierModels: Object.fromEntries(AutoTiers.map((tier) => [tier.ID, [...tier.Models]])) }
}

/** The router settings with anything missing or unknown filled in from the defaults. */
export function autoRouterOf(settings: { autoRouter?: AutoRouterSettings }): AutoRouterSettings {
  const saved = settings.autoRouter
  const shown = (saved?.tiers ?? []).filter((id) => AUTO_STOP_IDS.includes(id))
  const defaults = defaultAutoRouter()
  return {
    // Kept in picker order, whatever order they were saved in.
    tiers: shown.length ? AUTO_STOP_IDS.filter((id) => shown.includes(id)) : defaults.tiers,
    tierModels: Object.fromEntries(AutoTiers.map((tier) => [tier.ID, routesOf(tier.ID, saved?.tierModels?.[tier.ID])]))
  }
}

/** The models an Auto tier id may route to, or null when the id is not a tier. */
export function autoTierModels(id: string, settings: { autoRouter?: AutoRouterSettings } = {}): string[] | null {
  if (!id.startsWith(AUTO_TIER_PREFIX)) return null
  const tier = id.slice(AUTO_TIER_PREFIX.length)
  return AutoTiers.some((entry) => entry.ID === tier) ? autoRouterOf(settings).tierModels[tier] : null
}

/** The stops above Free on Auto's slider, in order, for every tier in AutoTiers. */
export const AUTO_TIER_MODELS: ResolvedModel[] = AutoTiers.map((tier) => ({
  ...PREMIUM_MODEL,
  key: modelKey('Default', AUTO_TIER_PREFIX + tier.ID),
  name: tier.DisplayName,
  id: AUTO_TIER_PREFIX + tier.ID,
  description: tier.Description
}))

/** The tier stops the picker offers under Auto, from the tiers chosen in Settings. Free is not included. */
export function autoPickerTiers(settings: { autoRouter?: AutoRouterSettings }): ResolvedModel[] {
  const shown = autoRouterOf(settings).tiers
  return AUTO_TIER_MODELS.filter((model) => shown.includes(model.id.slice(AUTO_TIER_PREFIX.length)))
}

/** Every stop Auto's picker shows, in order, with the name each stop carries: Free when it is on, then the chosen tiers. */
export function autoPickerStops(settings: { autoRouter?: AutoRouterSettings }): { key: string; name: string }[] {
  const shown = autoRouterOf(settings).tiers
  return [
    ...(shown.includes(AUTO_FREE_STOP) ? [{ key: AUTO_MODEL.key, name: 'Free' }] : []),
    ...autoPickerTiers(settings).map((model) => ({ key: model.key, name: model.name }))
  ]
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
    ultrafastMode: false,
    vision: true,
    custom: false,
    enabled: true
  }
}

/** The model id of an ACP agent's entry. The agent's own config options choose the real model. */
export const ACP_MODEL_ID = 'default'

export function resolveModels(settings: Pick<Settings, 'customModels' | 'customProviders' | 'disabledModels' | 'enabledModels'>): ResolvedModel[] {
  const disabled = new Set(settings.disabledModels)
  const enabled = new Set(settings.enabledModels ?? [])
  const seen = new Set<string>()
  const out: ResolvedModel[] = []
  for (const model of [
    AUTO_MODEL,
    PREMIUM_MODEL,
    ...AUTO_TIER_MODELS,
    ...AgentModel.map((spec) => fromSpec(spec, disabled, enabled)),
    ...AcpAgents.map((agent) => fromAcpAgent(agent.DisplayName)),
    ...settings.customModels.filter((custom) => !ACP_ACCOUNTS.includes(SUBSCRIPTION_ACCOUNT[custom.subscription] ?? '')).map((custom) => fromCustom(custom, disabled)),
    ...settings.customProviders.filter((provider) => provider.enabled && provider.api !== 'decisions' && provider.api !== 'images').flatMap((provider) => provider.models.map((model) => fromCustom({ name: model, id: customModelId(provider.id, model), subscription: 'Default' }, disabled)))
  ]) {
    if (seen.has(model.key)) continue
    seen.add(model.key)
    out.push(model)
  }
  return out
}

/** The built-in image models, then the models of each enabled custom provider that speaks the Images API. */
export function resolveImageModels(settings?: Pick<Settings, 'customProviders'>): ResolvedImageModel[] {
  const builtIn = ImageModel.map((spec) => ({
    key: modelKey(spec.Subscription, spec.ID),
    name: spec.DisplayName,
    id: spec.ID,
    subscription: spec.Subscription
  }))
  const custom = (settings?.customProviders ?? [])
    .filter((provider) => provider.enabled && provider.api === 'images')
    .flatMap((provider) => provider.models.map((model) => ({ key: modelKey('Default', customModelId(provider.id, model)), name: `${model} (${provider.name})`, id: customModelId(provider.id, model), subscription: 'Default' as const })))
  return [...builtIn, ...custom]
}

export function findModel(models: ResolvedModel[], key: string | null | undefined): ResolvedModel | null {
  if (!key) return null
  return models.find((m) => m.key === key) ?? null
}

/** An account is usable only when its own switch is on, it was not removed, and AI subscriptions are on. */
export function accountEnabled(settings: Pick<Settings, 'accounts' | 'acpEnabled' | 'removedAccounts'>, id: AccountId): boolean {
  if (settings.accounts[id]?.enabled === false || settings.removedAccounts?.includes(id)) return false
  return settings.acpEnabled !== false
}

/** Accounts whose utility models cannot run: removed ones, or every one while AI subscriptions are off. */
export function unavailableAccounts(settings: Pick<Settings, 'acpEnabled' | 'removedAccounts'>): AccountId[] {
  return settings.acpEnabled === false ? ['claude', 'codex'] : (settings.removedAccounts ?? [])
}

/**
 * Galaxy uses the native engine. Claude Code and Codex require confirmed sign-in. ACP agents mostly cannot report
 * theirs up front, so they count as usable until they ask for sign-in, except keyless ones, which always run.
 */
export function availableSubscriptions(settings: Pick<Settings, 'accounts' | 'acpEnabled' | 'removedAccounts'>, statuses: AccountStatus[]): Subscription[] {
  return SUBSCRIPTIONS.filter((subscription) => {
    if (subscription === 'Default') return true
    const id = SUBSCRIPTION_ACCOUNT[subscription]
    // An enabled provider is offered even before sign-in; the composer asks for sign-in when it needs one.
    return accountEnabled(settings, id) && statuses.some((status) => status.id === id && status.installed)
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
