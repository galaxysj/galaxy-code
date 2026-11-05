import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { app } from 'electron'
import { DUPLICATE_REGISTRY_IDS } from '@shared/acp-registry'
import type { AcpAgentConfig, AcpRegistryAgent } from '@shared/types'
import { errorMessage, exists, run } from '../util'

/** The Agent Client Protocol's public agent registry. */
const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'
const CACHE_MS = 60 * 60 * 1000

interface PackageDist {
  package: string
  args?: string[]
  env?: Record<string, string>
}

interface BinaryTarget {
  archive: string
  cmd: string
  args?: string[]
  env?: Record<string, string>
  sha256?: string
}

interface RegistryEntry {
  id: string
  name: string
  version: string
  description?: string
  icon?: string
  website?: string
  repository?: string
  distribution: { npx?: PackageDist; uvx?: PackageDist; binary?: Record<string, BinaryTarget> }
}

let cached: { at: number; agents: RegistryEntry[] } | null = null
const icons = new Map<string, Promise<string | undefined>>()

/**
 * A registry icon as a data URL, since the renderer only loads images from data URLs.
 * Registry icons are small SVGs drawn in currentColor; anything else is skipped.
 */
export function registryIcon(url: string | undefined): Promise<string | undefined> {
  if (!url || !/^https:\/\//.test(url)) return Promise.resolve(undefined)
  let icon = icons.get(url)
  if (!icon) {
    icon = fetch(url, { signal: AbortSignal.timeout(10000) })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const svg = (await res.text()).trim()
        if (svg.length > 64 * 1024 || !/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(svg)) return undefined
        return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
      })
      .catch(() => {
        icons.delete(url)
        return undefined
      })
    icons.set(url, icon)
  }
  return icon
}

function cacheFile(): string {
  return join(app.getPath('userData'), 'acp-registry.json')
}

/** The registry's name for this machine, such as darwin-aarch64. */
function platformKey(): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch
  return `${os}-${arch}`
}

/** How an entry runs here: a binary for this platform first, as editors do, then npx, then uvx. */
function distributionOf(entry: RegistryEntry): AcpRegistryAgent['distribution'] | null {
  if (entry.distribution.binary?.[platformKey()]) return 'binary'
  if (entry.distribution.npx) return 'npx'
  if (entry.distribution.uvx) return 'uvx'
  return null
}

async function load(fresh: boolean): Promise<RegistryEntry[]> {
  if (cached && !fresh && Date.now() - cached.at < CACHE_MS) return cached.agents
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { agents?: RegistryEntry[] }
    const agents = Array.isArray(body.agents) ? body.agents : []
    cached = { at: Date.now(), agents }
    void writeFile(cacheFile(), JSON.stringify(agents)).catch(() => {})
    return agents
  } catch (err) {
    // Offline, the last copy still lists what can be added.
    const saved = await readFile(cacheFile(), 'utf8').then((text) => JSON.parse(text) as RegistryEntry[]).catch(() => null)
    if (saved) return saved
    throw new Error(`Could not load the ACP registry: ${errorMessage(err)}`)
  }
}

/** Registry agents that can run on this machine, apart from ones Galaxy Code already runs on its own. */
export async function registryAgents(fresh = false): Promise<AcpRegistryAgent[]> {
  const agents = await load(fresh)
  const listed = agents.flatMap((entry) => {
    const distribution = distributionOf(entry)
    if (!distribution || !entry.id || !entry.name || DUPLICATE_REGISTRY_IDS.has(entry.id)) return []
    return [{ entry, distribution }]
  })
  return Promise.all(listed.map(async ({ entry, distribution }) => {
    const icon = await registryIcon(entry.icon)
    return {
      id: entry.id,
      name: entry.name,
      version: entry.version,
      description: entry.description ?? '',
      ...(icon ? { icon } : {}),
      ...(entry.website || entry.repository ? { website: entry.website ?? entry.repository } : {}),
      distribution
    }
  }))
}

/** Icons for registry agents added before icons were saved, keyed by agent id. */
export async function missingRegistryIcons(agents: AcpAgentConfig[]): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  const missing = agents.filter((agent) => agent.registry && !agent.registry.icon)
  if (!missing.length) return found
  const entries = await load(false).catch(() => [] as RegistryEntry[])
  await Promise.all(missing.map(async (agent) => {
    const icon = await registryIcon(entries.find((entry) => entry.id === agent.registry!.id)?.icon)
    if (icon) found.set(agent.id, icon)
  }))
  return found
}

/** Downloads and unpacks a binary release into the app's data folder, checking its digest when the registry has one. */
async function installBinary(entry: RegistryEntry, target: BinaryTarget): Promise<string> {
  const dir = join(installRoot(entry.id), entry.version)
  const command = resolve(dir, target.cmd)
  if (!command.startsWith(dir + sep)) throw new Error('The registry entry points outside its install folder.')
  if (await exists(command)) return command

  const res = await fetch(target.archive, { signal: AbortSignal.timeout(10 * 60 * 1000) })
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)
  const data = Buffer.from(await res.arrayBuffer())
  if (target.sha256 && createHash('sha256').update(data).digest('hex') !== target.sha256.toLowerCase()) {
    throw new Error('The download does not match the checksum in the registry.')
  }

  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const name = new URL(target.archive).pathname.split('/').pop() ?? 'archive'
  const archive = join(dir, `.download-${name}`)
  await writeFile(archive, data)
  try {
    const unpack = /\.zip$/i.test(name) ? await run('unzip', ['-q', '-o', archive, '-d', dir], { timeout: 120000 }) : /\.(tar\.gz|tgz|tar\.xz|tar\.bz2|tar)$/i.test(name) ? await run('tar', ['-xf', archive, '-C', dir], { timeout: 120000 }) : null
    if (!unpack) {
      // A bare executable rather than an archive.
      await writeFile(command, data)
    } else if (unpack.code !== 0) {
      throw new Error(`Could not unpack ${name}: ${(unpack.stderr || unpack.stdout).trim()}`)
    }
  } finally {
    await rm(archive, { force: true })
  }
  if (!(await exists(command))) throw new Error(`${target.cmd} was not in the download.`)
  if (process.platform !== 'win32') await chmod(command, 0o755)
  return command
}

interface RegistryLaunch {
  command: string
  args: string[]
  env: Record<string, string>
}

/** How to start a registry entry here, downloading its binary first when it ships as one. */
async function launchOf(entry: RegistryEntry): Promise<RegistryLaunch> {
  switch (distributionOf(entry)) {
    case 'binary': {
      const target = entry.distribution.binary![platformKey()]
      const launch = { command: await installBinary(entry, target), args: target.args ?? [], env: target.env ?? {} }
      // Remembered so the agent starts offline, and so status checks can find it without the network.
      await writeFile(join(installRoot(entry.id), 'current.json'), JSON.stringify(launch))
      return launch
    }
    case 'npx': {
      const dist = entry.distribution.npx!
      return { command: 'npx', args: ['--yes', dist.package, ...(dist.args ?? [])], env: dist.env ?? {} }
    }
    case 'uvx': {
      const dist = entry.distribution.uvx!
      return { command: 'uvx', args: [dist.package, ...(dist.args ?? [])], env: dist.env ?? {} }
    }
    default:
      throw new Error(`${entry.name} has no release for this computer.`)
  }
}

function installRoot(id: string): string {
  return join(app.getPath('userData'), 'acp-agents', id)
}

/** The downloaded binary of a registry entry, if one is installed. Never touches the network. */
export async function installedRegistryLaunch(id: string): Promise<RegistryLaunch | null> {
  const saved = await readFile(join(installRoot(id), 'current.json'), 'utf8').then((text) => JSON.parse(text) as RegistryLaunch).catch(() => null)
  return saved && (await exists(saved.command)) ? saved : null
}

/** Starts a library agent that runs a registry release: the current one, or the one already installed when offline. */
export async function registryLaunch(id: string): Promise<RegistryLaunch> {
  const entry = await load(false).then((agents) => agents.find((agent) => agent.id === id), () => undefined)
  if (entry) return launchOf(entry)
  const installed = await installedRegistryLaunch(id)
  if (installed) return installed
  throw new Error(`${id} is not in the ACP registry.`)
}

/** Gets a registry agent ready to run and returns the Settings entry for it. */
export async function installRegistryAgent(id: string): Promise<AcpAgentConfig> {
  const entry = (await load(false)).find((agent) => agent.id === id)
  if (!entry) throw new Error(`${id} is not in the ACP registry.`)
  if (DUPLICATE_REGISTRY_IDS.has(entry.id)) throw new Error(`${entry.name} is already built into Galaxy Code.`)
  const icon = await registryIcon(entry.icon)
  const registry = { id: entry.id, version: entry.version, ...(entry.description ? { description: entry.description } : {}), ...(icon ? { icon } : {}) }
  return { id: `acp_${entry.id.replace(/[^A-Za-z0-9_-]/g, '_')}`, name: entry.name, registry, ...(await launchOf(entry)) }
}
