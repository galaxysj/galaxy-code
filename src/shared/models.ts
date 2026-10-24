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
 */

/** 'Default', 'Claude', 'Codex', or an ACP agent's DisplayName from acp-registry.ts. */
export type Subscription = 'Default' | 'Claude' | 'Codex' | (string & {})

export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AgentModelSpec {
  DisplayName: string
  ID: string
  Subscription: Subscription
  Efforts: Effort[]
  UltraEffort: Effort | ''
  FastMode: boolean
  /** Effort preselected the first time the model is picked. Defaults to the middle stop. */
  DefaultEffort?: Effort
  /** Set false for models that cannot take image input. Defaults to true. */
  Vision?: boolean
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

export const AgentModel: AgentModelSpec[] = [
  // OpenRouter claude
  {
    DisplayName: 'Opus 5.5',
    ID: 'anthropic/claude-opus-5.5',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'xhigh',
    FastMode: true
  },
  {
    DisplayName: 'Fable 5.1',
    ID: 'anthropic/claude-fable-5.1',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'xhigh',
    FastMode: false
  },
  {
    DisplayName: 'Sonnet 5.5',
    ID: 'anthropic/claude-sonnet-5.5',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'xhigh',
    FastMode: false
  },
  {
    DisplayName: 'Haiku 5.5',
    ID: 'anthropic/claude-haiku-5.5',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    UltraEffort: '',
    FastMode: false
  },
// OpenRouter Claude Legacy
  {
    DisplayName: 'Sonnet 5',
    ID: 'anthropic/claude-sonnet-5',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'xhigh',
    FastMode: false
  },
  {
    DisplayName: 'Haiku 4.5',
    ID: 'anthropic/claude-haiku-4.5',
    Subscription: 'Default',
    Efforts: [],
    UltraEffort: '',
    FastMode: false
  },
  {
    DisplayName: 'Opus 5',
    ID: 'anthropic/claude-opus-5',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'xhigh',
    FastMode: true
  },
  {
    DisplayName: 'Opus 4.8',
    ID: 'anthropic/claude-opus-4.8',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    UltraEffort: 'xhigh',
    FastMode: false
  },
  {
    DisplayName: 'Fable 5',
    ID: 'anthropic/claude-fable-5',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    UltraEffort: 'xhigh',
    FastMode: false
  },




//Openrouter GPT
  
  {
    DisplayName: 'GPT-6 Astra',
    ID: 'openai/gpt-6-astra',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    UltraEffort: 'xhigh',
    FastMode: true
  },
  {
    DisplayName: 'GPT-6.1 Sol',
    ID: 'openai/gpt-6.1-sol',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    UltraEffort: 'xhigh',
    FastMode: true
  },
  {
    DisplayName: 'GPT-6 Luna',
    ID: 'openai/gpt-6-luna',
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
    Subscription: 'Default',
    Efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    DefaultEffort: 'medium',
    UltraEffort: 'xhigh',
    FastMode: false
  },
  {
    DisplayName: 'GPT-5.6 Sol',
    ID: 'openai/gpt-5.6-sol',
    Subscription: 'Default',
    Efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    DefaultEffort: 'medium',
    UltraEffort: 'xhigh',
    FastMode: true
  },
  {
    DisplayName: 'GPT-5.6 Terra',
    ID: 'openai/gpt-5.6-terra',
    Subscription: 'Default',
    Efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    DefaultEffort: 'medium',
    UltraEffort: 'xhigh',
    FastMode: true
  },
  {
    DisplayName: 'GPT-5.6 Luna',
    ID: 'openai/gpt-5.6-terra',
    Subscription: 'Default',
    Efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    DefaultEffort: 'medium',
    UltraEffort: 'max',
    FastMode: true
  },
  {
    DisplayName: 'GPT-5.5',
    ID: 'openai/gpt-5.5',
    Subscription: 'Default',
    Efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    DefaultEffort: 'medium',
    UltraEffort: 'xhigh',
    FastMode: true
  },


  
  {
    DisplayName: 'Gemini 3.8 Flash',
    ID: 'google/gemini-3.8-flash',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high'],
    UltraEffort: 'high',
    FastMode: false
  },
  {
    DisplayName: 'Gemini 3.1 Pro',
    ID: 'google/gemini-3.1-pro-preview',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high'],
    UltraEffort: 'high',
    FastMode: false
  },
  {
    DisplayName: 'Grok 4.7',
    ID: 'x-ai/grok-4.7',
    Subscription: 'Default',
    Efforts: ['low', 'medium', 'high', 'xhigh'],
    DefaultEffort: 'high',
    UltraEffort: 'xhigh',
    FastMode: false
  },
  {
    DisplayName: 'Kimi K3',
    ID: 'moonshotai/kimi-k3',
    Subscription: 'Default',
    Efforts: ['low', 'high', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'high',
    FastMode: false
  },
  {
    DisplayName: 'DeepSeek V4 Pro',
    ID: 'deepseek/deepseek-v4-pro-0813',
    Subscription: 'Default',
    Efforts: ['low', 'high', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'max',
    FastMode: false,
    Vision: false
  },
  {
    DisplayName: 'GLM 5.3',
    ID: 'z-ai/glm-5.3',
    Subscription: 'Default',
    Efforts: ['low', 'high', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'max',
    FastMode: false,
    Vision: false
  },






  
  // Claude account (Claude Code)
  {
    DisplayName: 'Opus 5.5',
    ID: 'claude-opus-5-5',
    Subscription: 'Claude',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'xhigh',
    FastMode: true
  },
  {
    DisplayName: 'Fable 5.1',
    ID: 'claude-fable-5-1',
    Subscription: 'Claude',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'xhigh',
    FastMode: false
  },
  {
    DisplayName: 'Sonnet 5.5',
    ID: 'claude-sonnet-5-5',
    Subscription: 'Claude',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    DefaultEffort: 'high',
    UltraEffort: 'xhigh',
    FastMode: false
  },
  {
    DisplayName: 'Haiku 5.5',
    ID: 'claude-haiku-5-5',
    Subscription: 'Claude',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    UltraEffort: 'xhigh',
    FastMode: false
  },




  
  // Codex account (ChatGPT)
  {
    DisplayName: 'GPT-6 Astra',
    ID: 'gpt-6-astra',
    Subscription: 'Codex',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    UltraEffort: 'xhigh',
    FastMode: true
  },
  {
    DisplayName: 'GPT-6.1 Sol',
    ID: 'gpt-6.1-sol',
    Subscription: 'Codex',
    Efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    UltraEffort: 'xhigh',
    FastMode: true
  },
  {
    DisplayName: 'GPT-6 Luna',
    ID: 'gpt-6-luna',
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

/** The single model Auto mode asks, through the OpenRouter Decisions API, whether an action is safe. */
export const AutoApprovalModel: UtilityModelSpec = {
  DisplayName: 'GPT-6 Luna Decisions',
  ID: 'openai/gpt-6-luna-decisions'
}

/** Names new chats from the first message. Runs on OpenRouter. */
export const TitleModel: UtilityModelSpec = {
  DisplayName: 'Claude Haiku 5.5',
  ID: 'anthropic/claude-haiku-5.5'
}
