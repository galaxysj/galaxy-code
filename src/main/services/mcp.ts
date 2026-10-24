import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { McpServerConfig, McpServerStatus } from '@shared/types'
import { store } from '../store'
import { errorMessage, truncateEnd } from '../util'

export interface McpTool {
  /** Name exposed to the model: mcp__<server>__<tool>. */
  qualified: string
  server: string
  serverId: string
  name: string
  description: string
  inputSchema: unknown
  readOnly: boolean
}

interface Connection {
  config: McpServerConfig
  signature: string
  client: Client | null
  status: McpServerStatus
  tools: McpTool[]
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'server'
}

class McpManager {
  private connections = new Map<string, Connection>()
  private listener: (statuses: McpServerStatus[]) => void = () => {}

  onStatus(listener: (statuses: McpServerStatus[]) => void): void {
    this.listener = listener
  }

  statuses(): McpServerStatus[] {
    return store.settings.mcpServers.map(
      (config) =>
        this.connections.get(config.id)?.status ?? { id: config.id, state: config.enabled ? 'connecting' : 'disabled', tools: [] }
    )
  }

  private notify(): void {
    this.listener(this.statuses())
  }

  /** Brings live connections in line with settings. Call after any settings change. */
  async sync(): Promise<void> {
    const wanted = new Map(store.settings.mcpServers.map((s) => [s.id, s]))
    for (const [id, conn] of this.connections) {
      const config = wanted.get(id)
      if (!config || !config.enabled || JSON.stringify(config) !== conn.signature) {
        await this.close(id)
      }
    }
    await Promise.all(
      [...wanted.values()].filter((c) => c.enabled && !this.connections.has(c.id)).map((config) => this.connect(config))
    )
    this.notify()
  }

  async reconnect(id: string): Promise<void> {
    await this.close(id)
    const config = store.settings.mcpServers.find((s) => s.id === id)
    if (config?.enabled) await this.connect(config)
    this.notify()
  }

  private async close(id: string): Promise<void> {
    const conn = this.connections.get(id)
    this.connections.delete(id)
    try {
      await conn?.client?.close()
    } catch {
      // already gone
    }
  }

  private async connect(config: McpServerConfig): Promise<void> {
    const conn: Connection = {
      config,
      signature: JSON.stringify(config),
      client: null,
      status: { id: config.id, state: 'connecting', tools: [] },
      tools: []
    }
    this.connections.set(config.id, conn)
    this.notify()

    try {
      const client = new Client({ name: 'galaxy-code', version: '0.1.0' }, { capabilities: {} })
      if (config.transport === 'stdio') {
        if (!config.command?.trim()) throw new Error('No command configured')
        const env: Record<string, string> = {}
        for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') env[key] = value
        await client.connect(
          new StdioClientTransport({
            command: config.command.trim(),
            args: config.args ?? [],
            env: { ...env, ...(config.env ?? {}) },
            stderr: 'ignore'
          })
        )
      } else {
        if (!config.url?.trim()) throw new Error('No URL configured')
        const url = new URL(config.url.trim())
        const requestInit = { headers: config.headers ?? {} }
        try {
          await client.connect(new StreamableHTTPClientTransport(url, { requestInit }))
        } catch {
          // Older servers only speak SSE.
          await client.connect(new SSEClientTransport(url, { requestInit }))
        }
      }
      // Stale: the config changed while we were connecting.
      if (this.connections.get(config.id) !== conn) {
        await client.close().catch(() => {})
        return
      }

      const listed = await client.listTools()
      const server = sanitize(config.name)
      conn.client = client
      conn.tools = listed.tools.map((tool) => ({
        qualified: `mcp__${server}__${tool.name}`,
        server: config.name,
        serverId: config.id,
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
        readOnly: tool.annotations?.readOnlyHint === true
      }))
      conn.status = {
        id: config.id,
        state: 'ready',
        tools: conn.tools.map((t) => ({ name: t.name, description: t.description }))
      }
      client.onclose = () => {
        if (this.connections.get(config.id) !== conn) return
        conn.client = null
        conn.tools = []
        conn.status = { id: config.id, state: 'error', error: 'Connection closed', tools: [] }
        this.notify()
      }
    } catch (err) {
      if (this.connections.get(config.id) !== conn) return
      conn.status = { id: config.id, state: 'error', error: errorMessage(err), tools: [] }
    }
    this.notify()
  }

  tools(): McpTool[] {
    return [...this.connections.values()].flatMap((c) => c.tools)
  }

  find(qualified: string): McpTool | null {
    return this.tools().find((t) => t.qualified === qualified) ?? null
  }

  async call(
    tool: McpTool,
    args: unknown,
    signal?: AbortSignal
  ): Promise<{ text: string; images: { mime: string; base64: string }[]; isError: boolean }> {
    const client = this.connections.get(tool.serverId)?.client
    if (!client) throw new Error(`MCP server "${tool.server}" is not connected`)
    const result = await client.callTool(
      { name: tool.name, arguments: (args ?? {}) as Record<string, unknown> },
      undefined,
      { signal, timeout: 10 * 60 * 1000 }
    )
    const texts: string[] = []
    const images: { mime: string; base64: string }[] = []
    for (const part of (result.content ?? []) as { type: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string; uri?: string } }[]) {
      if (part.type === 'text' && part.text) texts.push(part.text)
      else if (part.type === 'image' && part.data) images.push({ mime: part.mimeType ?? 'image/png', base64: part.data })
      else if (part.type === 'resource' && part.resource) texts.push(part.resource.text ?? part.resource.uri ?? '')
    }
    if (texts.length === 0 && result.structuredContent) texts.push(JSON.stringify(result.structuredContent, null, 2))
    return { text: truncateEnd(texts.join('\n'), 60000), images, isError: result.isError === true }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.close(id)))
  }
}

export const mcp = new McpManager()
