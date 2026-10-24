import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { runTool, type ToolDef, type ToolEnv } from '../tools'
import { errorMessage } from '../util'

interface BridgeContext {
  tools: ToolDef[]
  env: ToolEnv
}

export interface BridgeHandle {
  /** MCP endpoint for the CLI to connect to. The path carries the access token. */
  url: string
  /** Swaps in the environment of the current run, e.g. a fresh abort signal. */
  update(env: ToolEnv): void
  dispose(): void
}

export const BRIDGE_SERVER_NAME = 'galaxy'

/**
 * A loopback MCP server that lends Galaxy Code's own tools (Browser, Ask, Task,
 * Present, Open, Memory, ImageGeneration) to account CLIs. Each chat gets a
 * private URL; calls arriving on it run through the same tool runtime as the
 * built-in engine, so approvals and timeline items behave identically.
 */
class Bridge {
  private http: HttpServer | null = null
  private port = 0
  private contexts = new Map<string, BridgeContext>()
  private starting: Promise<void> | null = null

  private async start(): Promise<void> {
    if (this.http) return
    this.starting ??= new Promise((ready, fail) => {
      const server = createServer((req, res) => void this.handle(req, res))
      server.on('error', fail)
      server.listen(0, '127.0.0.1', () => {
        this.http = server
        this.port = (server.address() as AddressInfo).port
        ready()
      })
    })
    await this.starting
  }

  async register(tools: ToolDef[], env: ToolEnv): Promise<BridgeHandle> {
    await this.start()
    const token = randomBytes(24).toString('base64url')
    const context: BridgeContext = { tools: env.session.agentId === 'main' ? tools : tools.filter((tool) => tool.kind !== 'ask'), env }
    this.contexts.set(token, context)
    return {
      url: `http://127.0.0.1:${this.port}/mcp/${token}`,
      update: (next) => {
        context.env = next
      },
      dispose: () => {
        this.contexts.delete(token)
      }
    }
  }

  private buildServer(context: BridgeContext): Server {
    const server = new Server({ name: 'galaxy-code', version: '0.1.0' }, { capabilities: { tools: {} } })

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: context.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters as { type: 'object'; properties?: Record<string, unknown> }
      }))
    }))

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const { result } = await runTool(context.tools, context.env, request.params.name, request.params.arguments ?? {})
        return {
          content: [
            { type: 'text' as const, text: result.text },
            ...(result.images ?? []).map((image) => ({ type: 'image' as const, data: image.base64, mimeType: image.mime }))
          ],
          isError: result.isError === true
        }
      } catch (err) {
        return { content: [{ type: 'text' as const, text: errorMessage(err) }], isError: true }
      }
    })
    return server
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const match = (req.url ?? '').match(/^\/mcp\/([A-Za-z0-9_-]+)\/?(?:\?.*)?$/)
    const context = match ? this.contexts.get(match[1]) : undefined
    if (!context) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not found"}')
      return
    }
    if (req.method !== 'POST') {
      // Stateless: there is no server-initiated stream to open and no session to delete.
      res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' }).end(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null })
      )
      return
    }

    let body: unknown
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null })
      )
      return
    }

    const server = this.buildServer(context)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport as never)
      await transport.handleRequest(req, res, body)
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: errorMessage(err) }, id: null })
        )
      }
    }
  }

  shutdown(): void {
    this.http?.close()
    this.http = null
    this.contexts.clear()
  }
}

export const bridge = new Bridge()
