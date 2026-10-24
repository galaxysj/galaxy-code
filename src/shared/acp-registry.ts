/**
 * ACP agent registry. Every coding agent Galaxy Code reaches over the Agent
 * Client Protocol is listed here, apart from the model list. Edit it by hand
 * to add, remove or change an agent; nothing else needs to change.
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
  Args: string[]
  FullAccessArgs?: string[]
  Env?: Record<string, string>
  FullAccessEnv?: Record<string, string>
  UnsetEnv?: string[]
  Login?: string[]
  Status?: AcpStatusCheck
  Keyless?: boolean
  /** Added by the user in Settings rather than listed here. */
  Custom?: boolean
}

export const AcpAgents: AcpAgentSpec[] = [
  {
    ID: 'opencode',
    DisplayName: 'OpenCode',
    Description: 'Connects to the OpenCode CLI. Its free models work without signing in.',
    Binaries: ['opencode'],
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
    Args: ['acp'],
    Login: ['login'],
    Status: { Args: ['status'], SignedIn: 'logged in|authenticated', SignedOut: 'not logged in|not authenticated|login required' }
  },
  {
    ID: 'grok',
    DisplayName: 'Grok',
    Description: 'Connects to the Grok CLI.',
    Binaries: ['grok'],
    Args: ['--permission-mode', 'default', 'agent', 'stdio'],
    FullAccessArgs: ['agent', '--always-approve', 'stdio'],
    Env: { GROK_OAUTH2_REFERRER: 'galaxy-code' },
    Login: ['login']
  },
  {
    ID: 'antigravity',
    DisplayName: 'Antigravity',
    Description: 'Unofficial agy-acp adapter. Third-party account access may result in Google account restrictions or suspension. Requires Node.js 22+; downloads the adapter when needed.',
    Binaries: ['agy-acp'],
    Args: [],
    Login: ['--login']
  }
]
