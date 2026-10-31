import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { errorMessage } from '../util'

/** Model ids with this prefix run on the user's ChatGPT subscription, through the same backend the Codex CLI uses. */
export const CHATGPT_PREFIX = 'chatgpt/'
export const CHATGPT_API = 'https://chatgpt.com/backend-api/codex'

const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

interface AuthFile {
  auth_mode?: string
  OPENAI_API_KEY?: string | null
  tokens?: { id_token?: string; access_token?: string; refresh_token?: string; account_id?: string }
  last_refresh?: string
  [key: string]: unknown
}

export class ChatgptAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatgptAuthError'
  }
}

function authPath(): string {
  return join(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'auth.json')
}

async function readAuth(): Promise<AuthFile> {
  try {
    return JSON.parse(await readFile(authPath(), 'utf8')) as AuthFile
  } catch {
    throw new ChatgptAuthError('No Codex login found. Run `codex login` and sign in with ChatGPT.')
  }
}

function jwtExpiry(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { exp?: number }
    return (payload.exp ?? 0) * 1000
  } catch {
    return 0
  }
}

/** Rotates the tokens and saves them back, because the refresh token is single-use and the Codex CLI shares this file. */
async function refresh(auth: AuthFile): Promise<AuthFile> {
  const refreshToken = auth.tokens?.refresh_token
  if (!refreshToken) throw new ChatgptAuthError('The Codex login has no refresh token. Run `codex login` again.')
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken, scope: 'openid profile email' })
  })
  if (!res.ok) throw new ChatgptAuthError(`The ChatGPT login could not be refreshed (HTTP ${res.status}). Run \`codex login\` again.`)
  const json = (await res.json()) as { id_token?: string; access_token?: string; refresh_token?: string }
  if (!json.access_token) throw new ChatgptAuthError('The ChatGPT login refresh returned no access token.')
  const next: AuthFile = {
    ...auth,
    tokens: {
      ...auth.tokens,
      access_token: json.access_token,
      ...(json.id_token ? { id_token: json.id_token } : {}),
      refresh_token: json.refresh_token ?? refreshToken
    },
    last_refresh: new Date().toISOString()
  }
  const file = authPath()
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 })
    await rename(temp, file)
  } catch (err) {
    throw new ChatgptAuthError(`The ChatGPT login was refreshed but could not be saved: ${errorMessage(err)}`)
  }
  return next
}

let pending: Promise<AuthFile> | null = null

/** A valid login, refreshed when it is about to expire. Concurrent callers share one refresh. */
async function currentAuth(force = false): Promise<AuthFile> {
  const auth = await readAuth()
  const access = auth.tokens?.access_token
  if (!access) throw new ChatgptAuthError('Codex is not signed in with ChatGPT. Run `codex login` and choose Sign in with ChatGPT.')
  if (!force && jwtExpiry(access) - Date.now() > REFRESH_MARGIN_MS) return auth
  pending ??= refresh(auth).finally(() => { pending = null })
  return pending
}

/** Request headers for the ChatGPT backend. force re-reads and refreshes after a 401. */
export async function chatgptHeaders(force = false): Promise<Record<string, string>> {
  const auth = await currentAuth(force)
  const tokens = auth.tokens!
  return {
    Authorization: `Bearer ${tokens.access_token}`,
    ...(tokens.account_id ? { 'chatgpt-account-id': tokens.account_id } : {}),
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    originator: 'codex_cli_rs',
    'OpenAI-Beta': 'responses=experimental'
  }
}

export async function chatgptSignedIn(): Promise<boolean> {
  try {
    return !!(await readAuth()).tokens?.access_token
  } catch {
    return false
  }
}
