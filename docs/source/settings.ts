import { ACP_ACCOUNTS, type AccountId, type Settings } from '../../src/shared/types'
const ACCOUNT_IDS: AccountId[] = ['claude', 'codex', ...ACP_ACCOUNTS]

export function defaultSettings(): Settings {
  const accounts = {} as Settings['accounts']
  for (const id of ACCOUNT_IDS) accounts[id] = { enabled: true, binaryPath: '' }
  return {
    theme: 'system',
    terminalOutput: 'foreground',
    toolDensity: 'default',
    foldWork: true,
    expandToolCalls: true,
    defaultPermissionMode: 'auto',
    permissionDefaultsVersion: 1,
    defaultModelKey: null,
    disabledModels: [],
    enabledModels: [],
    customModels: [],
    imageModelKey: null,
    tabCompletion: true,
    completionModelId: null,
    inlineModelId: null,
    instantCommit: false,
    instantPush: false,
    modelPickerStyle: 'default',
    commitMessageModelId: null,
    autoApprovalModelId: null,
    disabledProviders: [],
    customProviders: [],
    creditLimit: null,
    accounts,
    acpEnabled: true,
    customAcpAgents: [],
    mcpServers: [],
    browserOpenLinks: 'built-in',
    browserSearchEngine: 'duckduckgo',
    browserBlockPopups: false,
    browserAgentControl: true,
    computerUse: false,
    appContext: true,
    appContextShortcut: 'CommandOrControl+Shift+7',
    computerMode: 'background',
    sidebarWidth: 272,
    panelWidth: 560,
    collapsedProjects: []
  }
}
