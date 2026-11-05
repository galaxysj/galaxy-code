/**
 * ACP agent library. The coding agents Galaxy Code knows how to reach over the
 * Agent Client Protocol, which Settings offers under Add agent. Only the ones
 * the user added are in use (AcpAgents below), alongside their custom agents.
 * Edit the library by hand to add or change an agent; nothing else needs to
 * change.
 *
 * Models, modes and other session options are not listed here. Each agent
 * reports them itself when a session opens (ACP session config options), and
 * the composer shows whatever it reports.
 *
 *   ID             Stable id saved in settings. Lowercase, never rename it.
 *   DisplayName    What Settings and the subscription picker show. Also keys
 *                  saved chats, so renaming it detaches existing chats.
 *   Description    One line shown under the agent in Settings.
 *   Binaries       Executables looked up on PATH, first match wins. Settings
 *                  can override this with an explicit path.
 *   RegistryId     Runs the release the public ACP registry lists under this
 *                  ID, downloaded on first use, instead of a binary on PATH.
 *   Runner         Used when none of Binaries is found: a package runner such
 *                  as npx or uvx, and the arguments that fetch and start a
 *                  pinned release.
 *   Args           Arguments that start the ACP server on stdio.
 *   FullAccessArgs Used instead of Args when the chat runs with Full access.
 *   Env            Extra environment variables for the server.
 *   FullAccessEnv  Used instead of Env when the chat runs with Full access.
 *   UnsetEnv       Variables removed from the inherited environment, as
 *                  regular expressions matched against the name. Use it to
 *                  keep provider keys from your shell out of the agent, so it
 *                  only offers models it can use on its own sign-ins.
 *   Login          Arguments that start the CLI's sign-in in a terminal.
 *                  Leave it out when the agent signs in from its own app.
 *   Status         How to ask the CLI whether it is signed in. SignedIn and
 *                  SignedOut are case-insensitive regular expressions matched
 *                  against its output; SignedOut wins when both match.
 *   Keyless        true when the agent still has free models without sign-in.
 *   RegistryIds    IDs of the public ACP registry entries for the same agent,
 *                  which Settings then leaves out of the registry list.
 */

export interface AcpStatusCheck {
  Args: string[]
  SignedIn?: string
  SignedOut?: string
}

export interface AcpAgentSpec {
  ID: string
  DisplayName: string
  Description: string
  Binaries: string[]
  RegistryId?: string
  Runner?: { Command: string; Args: string[] }
  Args: string[]
  FullAccessArgs?: string[]
  Env?: Record<string, string>
  FullAccessEnv?: Record<string, string>
  UnsetEnv?: string[]
  Login?: string[]
  Status?: AcpStatusCheck
  Keyless?: boolean
  RegistryIds?: string[]
  /** Added by the user in Settings rather than listed here. */
  Custom?: boolean
  /** Installed from the public ACP registry. */
  Registry?: boolean
}

export const AcpLibrary: AcpAgentSpec[] = [
  {
    ID: 'opencode',
    DisplayName: 'OpenCode',
    Description: 'Connects to the OpenCode CLI. Its free models work without signing in.',
    Binaries: ['opencode'],
    RegistryIds: ['opencode', 'opencode-v2'],
    Args: ['acp'],
    // OpenCode only asks before edits and commands when its config says so.
    Env: { OPENCODE_CONFIG_CONTENT: '{"permission":{"edit":"ask","bash":"ask","webfetch":"allow"}}' },
    FullAccessEnv: { OPENCODE_CONFIG_CONTENT: '{"permission":{"edit":"allow","bash":"allow","webfetch":"allow"}}' },
    // Without this OpenCode lists every model of every provider key in your shell.
    UnsetEnv: ['_API_KEY$', '_API_TOKEN$'],
    Login: ['auth', 'login'],
    Status: { Args: ['auth', 'list'], SignedIn: '[1-9]\\d*\\s+credentials?|\\b(oauth|api)\\b', SignedOut: '\\b0\\s+credentials?' },
    Keyless: true
  },
  {
    ID: 'cursor',
    DisplayName: 'Cursor',
    Description: 'Connects to the Cursor CLI.',
    Binaries: ['cursor-agent', 'agent'],
    RegistryIds: ['cursor'],
    Args: ['acp'],
    Login: ['login'],
    Status: { Args: ['status'], SignedIn: 'logged in|authenticated', SignedOut: 'not logged in|not authenticated|login required' }
  },
  {
    ID: 'grok',
    DisplayName: 'Grok',
    Description: 'Connects to the Grok CLI.',
    Binaries: ['grok'],
    RegistryIds: ['grok-build'],
    Runner: { Command: 'npx', Args: ['--yes', '@xai-official/grok@1.0.70'] },
    // Global flags come before the subcommand; without --always-approve Grok asks.
    Args: ['--no-auto-update', 'agent', 'stdio'],
    FullAccessArgs: ['--no-auto-update', '--always-approve', 'agent', 'stdio'],
    Env: { GROK_OAUTH2_REFERRER: 'galaxy-code' },
    Login: ['login']
  },
  {
    ID: 'antigravity',
    DisplayName: 'Antigravity',
    Description: "Google's Antigravity ACP server from the ACP registry. Downloads on first use.",
    Binaries: [],
    RegistryId: 'antigravity-acp',
    Args: []
  }
]

/** The agents in use: library entries and custom agents the user added in Settings, filled by applyAcpAgents. */
export const AcpAgents: AcpAgentSpec[] = []

/** Registry entries Galaxy Code already runs on its own: Claude Code and Codex, and every agent in the library. */
export const DUPLICATE_REGISTRY_IDS = new Set(['claude-acp', 'codex-acp', ...AcpLibrary.flatMap((agent) => [...(agent.RegistryIds ?? []), ...(agent.RegistryId ? [agent.RegistryId] : [])])])
