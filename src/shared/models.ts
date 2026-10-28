/**
 * Built-in model registry. This file is compiled into the app, edit it by hand
 * to change what ships. Nothing here is loaded from disk at runtime.
 *
 *   DisplayName   What the picker shows.
 *   ID            Model id sent to the provider.
 *   Subscription  Which connection serves it. 'Default' is OpenRouter (or the
 *                 BYOK endpoint from Settings); 'Claude' and 'Codex' are AI
 *                 accounts. ACP agents live in acp-registry.ts and report
 *                 their own models, so they are not listed here.
 *   Efforts       Reasoning efforts the slider offers, lowest to highest.
 *                 Leave empty for models without adjustable reasoning.
 *   UltraEffort   Effort used when Ultra is selected. Empty string means the
 *                 model cannot run Ultra.
 *   FastMode      true lets the user switch Fast on for this model.
 *   UltrafastMode true adds Ultrafast above Fast. Needs FastMode.
 *   Off           true ships the model switched off; users turn it on in Settings.
 */

/** 'Default', 'Claude', 'Codex', or an ACP agent's DisplayName from acp-registry.ts. */
export type Subscription = 'Default' | 'Claude' | 'Codex' | (string & {})

export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type ModelBrand = 'Gemini' | 'Claude' | 'GPT' | 'Grok'

export interface AgentModelSpec {
  /** Logo shown beside the model in the slash menu. */
  Brand?: ModelBrand
  DisplayName: string
  ID: string
  Subscription: Subscription
  Efforts: Effort[]
  UltraEffort: Effort | ''
  FastMode: boolean
  /** true offers Ultrafast (service tier 'ultrafast') on top of Fast. */
  UltrafastMode?: boolean
  /** Effort preselected the first time the model is picked. Defaults to the middle stop. */
  DefaultEffort?: Effort
  /** Set false for models that cannot take image input. Defaults to true. */
  Vision?: boolean
  /** true ships the model switched off until the user turns it on in Settings. */
  Off?: boolean
  /** Speed preselected the first time the model is picked. Fast needs FastMode, Ultrafast needs UltrafastMode. Defaults to 'Standard'. */
  DefaultSpeed?: 'Standard' | 'Fast' | 'Ultrafast'
  /** Context window in tokens. History is compacted when a prompt reaches 90% of it. Unset falls back to 200,000. */
  ContextWindow?: number
  /** Context sizes to choose from in the model picker, such as [300_000, 1_000_000]. Picking one sets where history is compacted. Unset shows no choice. */
  ContextOptions?: number[]
}

export interface ImageModelSpec {
  DisplayName: string
  ID: string
  Subscription: Subscription
}

export interface UtilityModelSpec {
  DisplayName: string
  ID: string
}

/** 'Default' runs on OpenRouter; 'Claude' and 'Codex' run on the signed-in account. */
export interface AccountUtilityModelSpec extends UtilityModelSpec {
  Subscription: 'Default' | 'Claude' | 'Codex'
}

/** Entries whose connection is available: OpenRouter ones always, account ones while that account is on. */
export function usableUtilityModels<T extends AccountUtilityModelSpec>(models: T[], accounts: Record<string, { enabled: boolean } | undefined>): T[] {
  return models.filter((model) => model.Subscription === 'Default' || accounts[model.Subscription === 'Claude' ? 'claude' : 'codex']?.enabled)
}

export function utilityModelLabel(model: AccountUtilityModelSpec): string {
  return model.Subscription === 'Default' ? model.DisplayName : `${model.DisplayName} (${model.Subscription})`
}

export const AgentModel: AgentModelSpec[] = [
  // OpenRouter claude
  {
    DisplayName: 'Sonnet 5.5',
    ID: 'anthropic/claude-sonnet-5.5',
    ContextOptions: [300_000, 1_000_000],
    Brand: 'Claude',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'xhigh',
    FastMode: false
  },
  {
    DisplayName: 'Opus 5.5',
    ID: 'anthropic/claude-opus-5.5',
    ContextOptions: [300_000, 1_000_000],
    Brand: 'Claude',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'xhigh',
    FastMode: true
  },
  {
    DisplayName: 'Fable 5.1',
    ID: 'anthropic/claude-fable-5.1',
    ContextOptions: [300_000, 1_000_000],
    Brand: 'Claude',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'xhigh',
    FastMode: false,
    Off: true
  },

  {
    DisplayName: 'Haiku 5.5',
    ID: 'anthropic/claude-haiku-5.5',
    ContextOptions: [300_000, 1_000_000],
    Brand: 'Claude',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    UltraEffort: '',
    FastMode: false,
    Off: true
  },
// OpenRouter Claude Legacy
  {
    DisplayName: 'Sonnet 5',
    ID: 'anthropic/claude-sonnet-5',
    ContextOptions: [300_000, 1_000_000],
    Brand: 'Claude',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'xhigh',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'Haiku 4.5',
    ID: 'anthropic/claude-haiku-4.5',
    ContextWindow: 200_000,
    Brand: 'Claude',
    Subscription: 'Default',
    Efforts: [],
    UltraEffort: '',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'Opus 5',
    ID: 'anthropic/claude-opus-5',
    ContextOptions: [300_000, 1_000_000],
    Brand: 'Claude',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'xhigh',
    FastMode: true,
    Off: true
  },
  {
    DisplayName: 'Opus 4.8',
    ID: 'anthropic/claude-opus-4.8',
    ContextOptions: [300_000, 1_000_000],
    Brand: 'Claude',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    UltraEffort: 'xhigh',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'Opus 4.7',
    ID: 'anthropic/claude-opus-4.7',
    ContextOptions: [300_000, 1_000_000],
    Brand: 'Claude',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    UltraEffort: 'xhigh',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'Opus 4.6',
    ID: 'anthropic/claude-opus-4.6',
    ContextOptions: [300_000, 1_000_000],
    Brand: 'Claude',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    UltraEffort: 'xhigh',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'Opus 4.5',
    ID: 'anthropic/claude-opus-4.5',
    ContextWindow: 200_000,
    Brand: 'Claude',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh'],
    UltraEffort: 'xhigh',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'Opus 4.1',
    ID: 'anthropic/claude-opus-4.1',
    ContextWindow: 200_000,
    Brand: 'Claude',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh'],
    UltraEffort: 'xhigh',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'Sonnet 4.6',
    ID: 'anthropic/claude-sonnet-4.6',
    ContextOptions: [300_000, 1_000_000],
    Brand: 'Claude',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh'],
    UltraEffort: 'xhigh',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'Sonnet 4.5',
    ID: 'anthropic/claude-sonnet-4.5',
    ContextOptions: [300_000, 1_000_000],
    Brand: 'Claude',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh'],
    UltraEffort: 'xhigh',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'Fable 5',
    ID: 'anthropic/claude-fable-5',
    ContextOptions: [300_000, 1_000_000],
    Brand: 'Claude',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    UltraEffort: 'xhigh',
    FastMode: false,
    Off: true
  },




//Openrouter GPT
  
  {
    DisplayName: 'GPT-6 Astra',
    ID: 'openai/gpt-6-astra',
    ContextOptions: [272_000, 1_050_000],
    Brand: 'GPT',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    UltraEffort: 'xhigh',
    FastMode: true,
    UltrafastMode: true
  },
  {
    DisplayName: 'GPT-6.1 Sol',
    ID: 'openai/gpt-6.1-sol',
    ContextOptions: [272_000, 1_050_000],
    Brand: 'GPT',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    UltraEffort: 'xhigh',
    FastMode: true
,
    UltrafastMode: true
  },
  {
    DisplayName: 'GPT-6.1 Terra',
    ID: 'openai/gpt-6.1-terra',
    ContextOptions: [272_000, 1_050_000],
    Brand: 'GPT',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    UltraEffort: 'xhigh',
    FastMode: true,
  },
  {
    DisplayName: 'GPT-6 Luna',
    ID: 'openai/gpt-6-luna',
    ContextOptions: [272_000, 1_050_000],
    Brand: 'GPT',
    Subscription: 'Default',
    Efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    DefaultEffort: 'medium',
    UltraEffort: 'max',
    FastMode: true
  },

//Legacy GPT

  {
    DisplayName: 'Codex 5.3',
    ID: 'openai/gpt-5.3-codex',
    ContextWindow: 400_000,
    Brand: 'GPT',
    Subscription: 'Default',
    Efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    DefaultEffort: 'medium',
    UltraEffort: 'xhigh',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'GPT-5.6 Sol',
    ID: 'openai/gpt-5.6-sol',
    ContextOptions: [272_000, 1_050_000],
    Brand: 'GPT',
    Subscription: 'Default',
    Efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    DefaultEffort: 'medium',
    UltraEffort: 'xhigh',
    FastMode: true,
    Off: true
  },
  {
    DisplayName: 'GPT-5.6 Terra',
    ID: 'openai/gpt-5.6-terra',
    ContextOptions: [272_000, 1_050_000],
    Brand: 'GPT',
    Subscription: 'Default',
    Efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    DefaultEffort: 'medium',
    UltraEffort: 'xhigh',
    FastMode: true,
    Off: true
  },
  {
    DisplayName: 'GPT-5.6 Luna',
    ID: 'openai/gpt-5.6-luna',
    ContextOptions: [272_000, 1_050_000],
    Brand: 'GPT',
    Subscription: 'Default',
    Efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    DefaultEffort: 'medium',
    UltraEffort: 'max',
    FastMode: true,
    Off: true
  },
  {
    DisplayName: 'GPT-5.5',
    ID: 'openai/gpt-5.5',
    ContextOptions: [272_000, 1_050_000],
    Brand: 'GPT',
    Subscription: 'Default',
    Efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    DefaultEffort: 'medium',
    UltraEffort: 'xhigh',
    FastMode: true,
    Off: true
  },
  {
    DisplayName: 'GPT-6 Sol',
    ID: 'openai/gpt-6-sol',
    ContextOptions: [272_000, 1_050_000],
    Brand: 'GPT',
    Subscription: 'Default',
    Efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    UltraEffort: 'xhigh',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'GPT-5.4',
    ID: 'openai/gpt-5.4',
    ContextOptions: [272_000, 1_050_000],
    Brand: 'GPT',
    Subscription: 'Default',
    Efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    UltraEffort: 'xhigh',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'GPT-5.4 Mini',
    ID: 'openai/gpt-5.4-mini',
    ContextWindow: 400_000,
    Brand: 'GPT',
    Subscription: 'Default',
    Efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    UltraEffort: 'xhigh',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'GPT-5.4 Nano',
    ID: 'openai/gpt-5.4-nano',
    ContextWindow: 400_000,
    Brand: 'GPT',
    Subscription: 'Default',
    Efforts: ['none', 'low', 'medium', 'high'],
    UltraEffort: 'high',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'Codex 5.2',
    ID: 'openai/gpt-5.2-codex',
    ContextWindow: 400_000,
    Brand: 'GPT',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh'],
    UltraEffort: 'xhigh',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'GPT-5.2',
    ID: 'openai/gpt-5.2',
    ContextWindow: 400_000,
    Brand: 'GPT',
    Subscription: 'Default',
    Efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    UltraEffort: 'xhigh',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'Codex 5.1 Max',
    ID: 'openai/gpt-5.1-codex-max',
    ContextWindow: 400_000,
    Brand: 'GPT',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh'],
    UltraEffort: 'xhigh',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'Codex 5.1',
    ID: 'openai/gpt-5.1-codex',
    ContextWindow: 400_000,
    Brand: 'GPT',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high'],
    UltraEffort: 'high',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'Codex 5.1 Mini',
    ID: 'openai/gpt-5.1-codex-mini',
    ContextWindow: 400_000,
    Brand: 'GPT',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high'],
    UltraEffort: 'high',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'GPT-5.1',
    ID: 'openai/gpt-5.1',
    ContextWindow: 400_000,
    Brand: 'GPT',
    Subscription: 'Default',
    Efforts: ['none', 'low', 'medium', 'high'],
    UltraEffort: 'high',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'GPT-5',
    ID: 'openai/gpt-5',
    ContextWindow: 400_000,
    Brand: 'GPT',
    Subscription: 'Default',
    Efforts: ['minimal', 'low', 'medium', 'high'],
    UltraEffort: 'high',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'GPT-5 Mini',
    ID: 'openai/gpt-5-mini',
    ContextWindow: 400_000,
    Brand: 'GPT',
    Subscription: 'Default',
    Efforts: ['minimal', 'low', 'medium', 'high'],
    UltraEffort: 'high',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'GPT-5 Nano',
    ID: 'openai/gpt-5-nano',
    ContextWindow: 400_000,
    Brand: 'GPT',
    Subscription: 'Default',
    Efforts: ['minimal', 'low', 'medium', 'high'],
    UltraEffort: 'high',
    FastMode: false,
    Off: true
  },


  
  {
    DisplayName: 'Gemini 4 Argon',
    ID: 'google/gemini-4-argon',
    ContextOptions: [272_000, 1_048_576],
    Brand: 'Gemini',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high'],
    DefaultEffort: 'high',
    UltraEffort: 'high',
    FastMode: false,
  },
  {
    DisplayName: 'Gemini 3.7 Flash',
    ID: 'google/gemini-3.7-flash',
    ContextWindow: 272_000,
    Brand: 'Gemini',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high'],
    UltraEffort: 'high',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'Gemini 3.6 Flash',
    ID: 'google/gemini-3.6-flash',
    ContextWindow: 272_000,
    Brand: 'Gemini',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high'],
    UltraEffort: 'high',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'Gemini 3.5 Flash',
    ID: 'google/gemini-3.5-flash',
    ContextWindow: 272_000,
    Brand: 'Gemini',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high'],
    UltraEffort: 'high',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'Gemini 3.5 Flash Lite',
    ID: 'google/gemini-3.5-flash-lite',
    ContextWindow: 272_000,
    Brand: 'Gemini',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high'],
    UltraEffort: 'high',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'Gemini 3.1 Flash Lite',
    ID: 'google/gemini-3.1-flash-lite',
    ContextWindow: 272_000,
    Brand: 'Gemini',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high'],
    UltraEffort: 'high',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'Gemini 3 Flash',
    ID: 'google/gemini-3-flash-preview',
    ContextWindow: 272_000,
    Brand: 'Gemini',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high'],
    UltraEffort: 'high',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'Gemini 3.8 Flash',
    ID: 'google/gemini-3.8-flash',
    ContextWindow: 272_000,
    Brand: 'Gemini',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high'],
    UltraEffort: 'high',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'Gemini 3.1 Pro',
    ID: 'google/gemini-3.1-pro-preview',
    ContextWindow: 272_000,
    Brand: 'Gemini',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high'],
    UltraEffort: 'high',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'Grok 4.7',
    ID: 'x-ai/grok-4.7',
    ContextOptions: [256_000, 500_000],
    Brand: 'Grok',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh'],
    DefaultEffort: 'high',
    UltraEffort: 'xhigh',
    FastMode: true,
    DefaultSpeed: 'Fast',
    Off: true
  },
  {
    DisplayName: 'Kimi K3',
    ID: 'moonshotai/kimi-k3',
    ContextWindow: 272_000,
    Subscription: 'Default',
    Efforts: ['low', 'high', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'high',
    FastMode: true,
    Off: true
  },
  {
    DisplayName: 'Kimi K3.1 Pro',
    ID: 'moonshotai/kimi-k3.1-pro',
    ContextOptions: [272_000, 1_048_576],
    Subscription: 'Default',
    Efforts: ['low', 'high', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'high',
    FastMode: true,
    Off: true
  },
  {
    DisplayName: 'DeepSeek V4 Pro',
    ID: 'deepseek/deepseek-v4-pro-0813',
    ContextOptions: [272_000, 1_048_576],
    Subscription: 'Default',
    Efforts: ['low', 'high', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'max',
    FastMode: false,
    Vision: false,
    Off: true
  },
  {
    DisplayName: 'DeepSeek V4.1 Flash',
    ID: 'deepseek/deepseek-v4.1-flash',
    ContextOptions: [272_000, 1_048_576],
    Subscription: 'Default',
    Efforts: ['low', 'high', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'max',
    FastMode: true,
    DefaultSpeed: 'Fast',
    Vision: false,
    Off: false
  },
  {
    DisplayName: 'GLM 5.3',
    ID: 'z-ai/glm-5.3',
    ContextOptions: [272_000, 1_048_576],
    Subscription: 'Default',
    Efforts: ['low', 'high', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'max',
    FastMode: false,
    Vision: false,
    Off: true
  },
  {
    DisplayName: 'Grok 4.6',
    ID: 'x-ai/grok-4.6',
    ContextOptions: [256_000, 500_000],
    Brand: 'Grok',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh'],
    DefaultEffort: 'high',
    UltraEffort: 'xhigh',
    FastMode: true,
    DefaultSpeed: 'Fast',
    Off: true
  },
  {
    DisplayName: 'Grok 4.5',
    ID: 'x-ai/grok-4.5',
    ContextOptions: [256_000, 500_000],
    Brand: 'Grok',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh'],
    DefaultEffort: 'high',
    UltraEffort: 'xhigh',
    FastMode: true,
    DefaultSpeed: 'Fast',
    Off: true
  },
  {
    DisplayName: 'Muse Wonder',
    ID: 'meta/muse-wonder',
    ContextOptions: [272_000, 1_048_576],
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high'],
    DefaultEffort: 'medium',
    UltraEffort: 'high',
    FastMode: false,
  },
  {
    DisplayName: 'Muse Spark 1.3',
    ID: 'meta/muse-spark-1.3',
    ContextOptions: [272_000, 1_048_576],
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high'],
    DefaultEffort: 'medium',
    UltraEffort: 'high',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'Kimi K2.7 Code',
    ID: 'moonshotai/kimi-k2.7-code',
    ContextWindow: 262_144,
    Subscription: 'Default',
    Efforts: ['low', 'high', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'high',
    FastMode: false,
    Off: true
  },
  {
    DisplayName: 'GLM 5.3 Flash',
    ID: 'z-ai/glm-5.3-flash',
    ContextOptions: [272_000, 1_048_576],
    Subscription: 'Default',
    Efforts: ['low', 'high', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'max',
    FastMode: false,
    Vision: false,
    Off: true
  },
  {
    DisplayName: 'GLM 5.2',
    ID: 'z-ai/glm-5.2',
    ContextOptions: [272_000, 1_048_576],
    Subscription: 'Default',
    Efforts: ['low', 'high', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'max',
    FastMode: false,
    Vision: false,
    Off: true
  },






  
  // Claude account (Claude Code)
  {
    DisplayName: 'Opus 5.5',
    ID: 'claude-opus-5-5',
    Brand: 'Claude',
    Subscription: 'Claude',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'xhigh',
    FastMode: true
  },
  {
    DisplayName: 'Fable 5.1',
    ID: 'claude-fable-5-1',
    Brand: 'Claude',
    Subscription: 'Claude',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'xhigh',
    FastMode: false
  },
  {
    DisplayName: 'Sonnet 5.5',
    ID: 'claude-sonnet-5-5',
    Brand: 'Claude',
    Subscription: 'Claude',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'xhigh',
    FastMode: false
  },
  {
    DisplayName: 'Haiku 5.5',
    ID: 'claude-haiku-5-5',
    Brand: 'Claude',
    Subscription: 'Claude',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    UltraEffort: 'xhigh',
    FastMode: false
  },




  
  // Codex account (ChatGPT)
  {
    DisplayName: 'GPT-6 Astra',
    ID: 'gpt-6-astra',
    Brand: 'GPT',
    Subscription: 'Codex',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    UltraEffort: 'xhigh',
    FastMode: true
  },
  {
    DisplayName: 'GPT-6.1 Sol',
    ID: 'gpt-6.1-sol',
    Brand: 'GPT',
    Subscription: 'Codex',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    UltraEffort: 'xhigh',
    FastMode: true
  },
  {
    DisplayName: 'GPT-6 Luna',
    ID: 'gpt-6-luna',
    Brand: 'GPT',
    Subscription: 'Codex',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    UltraEffort: 'max',
    FastMode: true
  },
]

/** The first entry is the default Image Generation Model. */
export const ImageModel: ImageModelSpec[] = [
  { DisplayName: 'GPT Image 2.5 Sunburst', ID: 'openai/gpt-image-2.5-sunburst', Subscription: 'Default' },
  { DisplayName: 'GPT Image 2.5 Flare', ID: 'openai/gpt-image-2.5-flare', Subscription: 'Default' },
  { DisplayName: 'Nano Banana 2.1', ID: 'google/gemini-nano-banana-2.1', Subscription: 'Default' },
  { DisplayName: 'Nano Banana Pro', ID: 'google/gemini-3-pro-image', Subscription: 'Default' },

]

/** Tab completion in the file editor. Settings picks one; the first entry is the default. Account entries show only while that account is on. */
export const CompletionModel: AccountUtilityModelSpec[] = [
  { DisplayName: 'Haiku', ID: '~anthropic/claude-haiku-latest', Subscription: 'Default' },
  { DisplayName: 'Luna', ID: '~openai/gpt-luna-latest', Subscription: 'Default' },
  { DisplayName: 'Mercury 3', ID: 'inception/mercury-3', Subscription: 'Default' },
  { DisplayName: 'Haiku 5.5', ID: 'claude-haiku-5-5', Subscription: 'Claude' },
  { DisplayName: 'GPT-6 Luna', ID: 'gpt-6-luna', Subscription: 'Codex' }
]

/** Ctrl+I inline edits in the file editor and terminal. The edit box picks one; the first entry is the default. Account entries show only while that account is on. */
export const InlineModel: AccountUtilityModelSpec[] = [
  { DisplayName: 'Haiku', ID: '~anthropic/claude-haiku-latest', Subscription: 'Default' },
  { DisplayName: 'Luna', ID: '~openai/gpt-luna-latest', Subscription: 'Default' },
  { DisplayName: 'Gemini Flash', ID: '~google/gemini-flash-latest', Subscription: 'Default' },
  { DisplayName: 'Sonnet', ID: '~anthropic/claude-sonnet-latest', Subscription: 'Default' },
  { DisplayName: 'Haiku 5.5', ID: 'claude-haiku-5-5', Subscription: 'Claude' },
  { DisplayName: 'Sonnet 5.5', ID: 'claude-sonnet-5-5', Subscription: 'Claude' },
  { DisplayName: 'GPT-6 Luna', ID: 'gpt-6-luna', Subscription: 'Codex' }
]

/** Writes the message for Instant commit. Picked in Settings > Git; subscription entries show only while that account is on. */
export const CommitMessageModel: AccountUtilityModelSpec[] = [
  { DisplayName: 'Luna', ID: '~openai/gpt-luna-latest', Subscription: 'Default' },
  { DisplayName: 'Haiku', ID: '~anthropic/claude-haiku-latest', Subscription: 'Default' },
  { DisplayName: 'Gemini Flash', ID: '~google/gemini-flash-latest', Subscription: 'Default' },
  { DisplayName: 'Haiku 5.5', ID: 'claude-haiku-5-5', Subscription: 'Claude' },
  { DisplayName: 'Sonnet 5.5', ID: 'claude-sonnet-5-5', Subscription: 'Claude' },
  { DisplayName: 'GPT-6 Luna', ID: 'gpt-6-luna', Subscription: 'Codex' }
]

/** Auto mode asks this model, through the OpenRouter Decisions API, whether an action is safe. Settings picks one; the first entry is the default. */
export const AutoApprovalModel: UtilityModelSpec[] = [
  { DisplayName: 'Luna Decisions', ID: 'openai/gpt-6-luna-decisions' },
  { DisplayName: 'Jev', ID: '~typesafe/jev-latest' },
  { DisplayName: 'Microsoft Decision ', ID: 'microsoft/microsoft-decision-1' }
]

export function resolveAutoApprovalModel(id: string | null | undefined): UtilityModelSpec {
  return AutoApprovalModel.find((model) => model.ID === id) ?? AutoApprovalModel[0]
}

/** Names new chats from the first message. Runs on OpenRouter. */
export const TitleModel: UtilityModelSpec = {
  DisplayName: 'Claude Haiku 5.5',
  ID: 'anthropic/claude-haiku-5.5'
}
