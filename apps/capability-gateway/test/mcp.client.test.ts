import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolGatewayConfigValue } from '../src/config/app-config.js'
import { callMcpTool, discoverMcpTools } from '../src/registry/mcp.client.js'
import { ServiceInvoker } from '../src/registry/service.invoker.js'
import { ServiceRegistry } from '../src/registry/service.registry.js'

const config: ToolGatewayConfigValue = {
  internalToken: 'token',
  staleAfterMs: 30_000,
  invokeTimeoutMs: 2_000,
  rateLimitPerMinute: 60,
  allowPrivateNetwork: true,
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}`
}

const json = (res: import('node:http').ServerResponse, body: unknown): void => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** 最小 MCP server：initialize / tools/list（两页）/ tools/call（含 isError 分支） */
const startMcp = async (): Promise<string> => {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as {
        id?: number
        method?: string
        params?: Record<string, unknown>
      }
      if (body.method === 'initialize') {
        res.setHeader('mcp-session-id', 'session-1')
        json(res, {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            serverInfo: { name: 'fake-mcp', version: '1.0.0' },
          },
        })
        return
      }
      if (body.method === 'notifications/initialized') {
        res.writeHead(202).end()
        return
      }
      // 后续请求必须带会话
      if (req.headers['mcp-session-id'] !== 'session-1') {
        res.writeHead(400).end('missing session')
        return
      }
      if (body.method === 'tools/list') {
        const cursor = body.params?.cursor
        json(res, {
          jsonrpc: '2.0',
          id: body.id,
          result: cursor
            ? {
                tools: [
                  {
                    name: 'fail.run',
                    description: '一定失败的工具',
                    inputSchema: { type: 'object' },
                  },
                ],
              }
            : {
                tools: [
                  {
                    name: 'echo_msg',
                    description: '回显文本',
                    inputSchema: {
                      type: 'object',
                      properties: { text: { type: 'string' } },
                      required: ['text'],
                    },
                  },
                ],
                nextCursor: 'page-2',
              },
        })
        return
      }
      if (body.method === 'tools/call') {
        const name = String(body.params?.name)
        const args = (body.params?.arguments ?? {}) as { text?: string }
        if (name === 'fail.run') {
          json(res, {
            jsonrpc: '2.0',
            id: body.id,
            result: { isError: true, content: [{ type: 'text', text: '工具炸了' }] },
          })
          return
        }
        json(res, {
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text: `echo:${args.text ?? ''}` }] },
        })
        return
      }
      json(res, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: '未知方法' } })
    })
  })
  servers.push(server)
  return listen(server)
}

describe('MCP client（网关作为 client）', () => {
  it('握手 → tools/list 分页拉全 → 工具名归一 + 保留原名', async () => {
    const base = await startMcp()
    const result = await discoverMcpTools({
      url: `${base}/mcp`,
      allowHttp: true,
      allowPrivateNetwork: true,
    })

    expect(result.protocolVersion).toBe('2025-06-18')
    expect(result.tools.map((tool) => tool.key)).toEqual(['echo-msg', 'fail-run'])
    expect(result.tools[0]).toMatchObject({ remoteTool: 'echo_msg', title: 'echo_msg' })
    expect(result.tools[0]!.inputSchema).toMatchObject({ type: 'object' })
  })

  it('tools/call 原样传回 MCP 原名，返回 content', async () => {
    const base = await startMcp()
    const endpoint = { url: `${base}/mcp`, allowHttp: true, allowPrivateNetwork: true }

    const result = await callMcpTool({
      ...endpoint,
      remoteTool: 'echo_msg',
      args: { text: '你好' },
    })
    expect(result).toMatchObject({
      ok: true,
      data: { content: [{ type: 'text', text: 'echo:你好' }] },
    })

    await discoverMcpTools(endpoint)
    const failed = await callMcpTool({ ...endpoint, remoteTool: 'fail.run', args: {} })
    expect(failed).toMatchObject({ ok: false, reason: 'mcp-tool-error', message: '工具炸了' })
  })

  it('invoke 路由：protocol=mcp 走 MCP client，不转发 /invoke', async () => {
    const base = await startMcp()
    const registry = new ServiceRegistry(config)
    await registry.register({
      protocolVersion: 1,
      service: 'fake-mcp',
      title: '假 MCP',
      owner: '测试',
      source: 'manual',
      protocol: 'mcp',
      baseUrl: base,
      healthPath: '/mcp',
      allowHttp: true,
      capabilities: [
        {
          tool: 'echo-msg',
          remoteTool: 'echo_msg',
          title: '回显',
          description: '回显文本',
        },
      ],
    })

    const invoker = new ServiceInvoker(registry, config)
    const result = await invoker.invoke({
      capability: 'echo-msg',
      input: { text: 'world' },
      caller: {
        conversationId: 'c-1',
        runId: 'run-1',
        agentKey: 'assistant',
        rootAgentKey: 'assistant',
        depth: 0,
      },
      deadlineMs: 5_000,
    })

    expect(result.service).toBe('fake-mcp')
    expect(result.instanceId).toBe('mcp')
    expect(result.outcome).toMatchObject({
      ok: true,
      data: { content: [{ type: 'text', text: 'echo:world' }] },
    })
  })
})

/** 只实现 2026-07-28 口径的 server：没有 initialize / 会话，直接 tools/list、tools/call */
const startStatelessMcp = async (): Promise<string> => {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { id?: number; method?: string }
      if (body.method === 'initialize') {
        json(res, {
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32601, message: 'method not found' },
        })
        return
      }
      if (body.method === 'tools/list') {
        json(res, {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object' } }],
          },
        })
        return
      }
      json(res, {
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: 'pong' }] },
      })
    })
  })
  servers.push(server)
  return listen(server)
}

describe('MCP 新版本（2026-07-28）：无握手 / 无会话', () => {
  it('initialize 返回「方法不存在」时按无状态继续列工具与调用', async () => {
    const base = await startStatelessMcp()
    const endpoint = { url: `${base}/mcp`, allowHttp: true, allowPrivateNetwork: true }

    const discovered = await discoverMcpTools(endpoint)
    expect(discovered.tools.map((tool) => tool.key)).toEqual(['ping'])

    const called = await callMcpTool({ ...endpoint, remoteTool: 'ping', args: {} })
    expect(called).toMatchObject({ ok: true, data: { content: [{ type: 'text', text: 'pong' }] } })
  })
})
