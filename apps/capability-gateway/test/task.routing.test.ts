import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { CapabilityInvokeRequest } from '@repo/contracts'
import type { ToolGatewayConfigValue } from '../src/config/app-config.js'
import { ServiceInvoker } from '../src/registry/service.invoker.js'
import { ServiceRegistry } from '../src/registry/service.registry.js'

const config: ToolGatewayConfigValue = {
  internalToken: 'token',
  staleAfterMs: 30_000,
  invokeTimeoutMs: 2_000,
  rateLimitPerMinute: 60,
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

const caller: CapabilityInvokeRequest['caller'] = {
  conversationId: 'c-1',
  runId: 'run-1',
  userId: 'u-1',
  isAdmin: false,
  agentKey: 'assistant',
  rootAgentKey: 'assistant',
  depth: 0,
}

describe('任务模式：受理 → 按 taskId 回原实例 → 查/取消', () => {
  it('受理后记下亲和映射，get/cancel 都回到同一服务', async () => {
    const calls: string[] = []
    let state = 'running'
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        calls.push(req.url ?? '')
        const payload = JSON.parse(body || '{}') as { taskId?: string }
        res.writeHead(200, { 'content-type': 'application/json' })
        if (req.url === '/invoke') {
          res.end(
            JSON.stringify({
              version: 1,
              ok: true,
              task: { id: 'task-1', state: 'running', pollAfterMs: 2_000 },
            }),
          )
          return
        }
        if (req.url === '/tasks/get') {
          res.end(
            JSON.stringify({
              version: 1,
              id: payload.taskId,
              state,
              ...(state === 'succeeded' ? { result: { ok: true, data: { stdout: 'done' } } } : {}),
            }),
          )
          return
        }
        state = 'canceled'
        res.end(JSON.stringify({ version: 1, id: payload.taskId, state: 'canceled' }))
      })
    })
    servers.push(server)
    const baseUrl = await listen(server)

    const registry = new ServiceRegistry(config)
    await registry.register({
      protocolVersion: 1,
      service: 'exec',
      title: '通用能力',
      owner: '平台组',
      source: 'code',
      instance: { instanceId: 'cc-1', endpoint: baseUrl, maxConcurrency: 8 },
      capabilities: [
        {
          tool: 'bash',
          title: '执行命令',
          description: '跑命令',
          execution: { mode: 'task' },
        },
      ],
    })
    const invoker = new ServiceInvoker(registry, config)

    const accepted = await invoker.invoke({
      capability: 'bash',
      input: { command: 'sleep 1' },
      caller,
      deadlineMs: 1_000,
    })
    expect(accepted.task).toMatchObject({ id: 'task-1', state: 'running' })
    expect(await registry.taskLocation('task-1')).toMatchObject({
      service: 'exec',
      instanceId: 'cc-1',
    })

    const got = await invoker.getTask({ taskId: 'task-1', waitMs: 100 })
    expect(got).toMatchObject({ id: 'task-1', state: 'running' })
    expect(calls).toEqual(['/invoke', '/tasks/get'])

    const canceled = await invoker.cancelTask('task-1')
    expect(canceled.state).toBe('canceled')
    expect(calls).toEqual(['/invoke', '/tasks/get', '/tasks/cancel'])
  })

  it('没登记过的 taskId 返回 expired，不瞎猜端点', async () => {
    const registry = new ServiceRegistry(config)
    const invoker = new ServiceInvoker(registry, config)
    expect(await invoker.getTask({ taskId: 'nope' })).toMatchObject({ state: 'expired' })
    expect(await invoker.cancelTask('nope')).toMatchObject({ state: 'expired' })
  })
})
