import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { CapabilityInvokeController } from '../src/invoke.controller.js'
import type { ToolWorkerConfigValue } from '../src/config/app-config.js'
import { TaskManager } from '../src/task.manager.js'
import type { ToolExecutorRegistry } from '../src/executors/executor.registry.js'
import type { ToolWorkerService } from '../src/worker.service.js'

const config = { internalToken: 'token' } as ToolWorkerConfigValue

const caller = {
  conversationId: 'c-1',
  runId: 'run-1',
  userId: 'u-1',
  isAdmin: false,
  agentKey: 'assistant',
  rootAgentKey: 'assistant',
  depth: 0,
}

const body = (over: Record<string, unknown> = {}) => ({
  version: 1,
  requestId: 'req-1',
  tool: 'bash',
  input: { command: 'echo hi' },
  reason: '用户要看输出',
  caller,
  deadlineMs: 1_000,
  ...over,
})

const build = (outcome: unknown = { ok: true, data: { stdout: 'hi' } }) => {
  const execute = vi.fn().mockResolvedValue(outcome)
  const service = { execute } as unknown as ToolWorkerService
  const executors = {
    get: (key: string) => (key === 'bash' ? {} : undefined),
    // 任务形态与任务寿命都取自声明（执行器注册表）
    isTaskTool: (key: string) => key === 'bash',
    maxRunMs: () => 1_800_000,
  } as unknown as ToolExecutorRegistry
  const controller = new CapabilityInvokeController(
    service,
    new TaskManager(service),
    config,
    executors,
  )
  return { controller, execute }
}

describe('POST /invoke（能力协议入口）', () => {
  it('工具名不带 namespace，服务自己映射到执行器', async () => {
    const { controller, execute } = build()
    const response = await controller.invoke('token', 'bash', undefined, body())

    expect(execute).toHaveBeenCalledTimes(1)
    const request = execute.mock.calls[0]![0] as {
      toolKey: string
      input: unknown
      deadlineMs: number
    }
    expect(request.toolKey).toBe('bash')
    expect(request.input).toEqual({ command: 'echo hi' })
    // 任务形态的执行预算取声明的 maxRunMs，而不是这次 HTTP 的 deadlineMs（1000）
    expect(request.deadlineMs).toBe(1_800_000)
    expect(response).toMatchObject({ version: 1, ok: true, data: { stdout: 'hi' } })
  })

  it('业务失败也是 HTTP 200 的三形态之一', async () => {
    const { controller } = build({
      ok: false,
      reason: 'sandbox-unavailable',
      message: '沙箱不可用',
      retryable: false,
    })
    const response = await controller.invoke('token', 'bash', undefined, body())
    expect(response).toMatchObject({
      version: 1,
      ok: false,
      reason: 'sandbox-unavailable',
      message: '沙箱不可用',
    })
  })

  it('不认识的工具返回 unknown-tool，不进执行器', async () => {
    const { controller, execute } = build()
    const response = await controller.invoke(
      'token',
      'exec/nope',
      undefined,
      body({ tool: 'nope' }),
    )
    expect(response).toMatchObject({ ok: false, reason: 'unknown-tool' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('令牌不对直接 403', async () => {
    const { controller } = build()
    await expect(controller.invoke('bad', 'bash', undefined, body())).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('body 不合法直接 400', async () => {
    const { controller } = build()
    await expect(controller.invoke('token', 'bash', undefined, { version: 1 })).rejects.toThrow(
      '不合法',
    )
  })
})

describe('x-capability-config 下发', () => {
  it('ASCII JSON 直接解析，挂到 request.settings', async () => {
    const { controller, execute } = build()
    await controller.invoke(
      'token',
      'bash',
      JSON.stringify({
        config: { baseUrl: 'https://api.example.com' },
        limits: { rateLimitPerMinute: 5 },
        secrets: { apiKey: 'k-1' },
        version: 'v1',
      }),
      body(),
    )
    const request = execute.mock.calls[0]![0] as {
      settings?: { config?: unknown; secrets?: unknown }
    }
    expect(request.settings).toMatchObject({
      config: { baseUrl: 'https://api.example.com' },
      limits: { rateLimitPerMinute: 5 },
      secrets: { apiKey: 'k-1' },
      version: 'v1',
    })
  })

  it('非 ASCII 用 b64: 前缀，解码后一致', async () => {
    const { controller, execute } = build()
    const settings = { config: { note: '中文配置' }, limits: {}, secrets: {}, version: 'v1' }
    const header = `b64:${Buffer.from(JSON.stringify(settings), 'utf8').toString('base64url')}`
    await controller.invoke('token', 'bash', header, body())
    const request = execute.mock.calls[0]![0] as { settings?: { config?: unknown } }
    expect(request.settings?.config).toEqual({ note: '中文配置' })
  })

  it('坏头不拦调用（按没有配置处理）', async () => {
    const { controller, execute } = build()
    await controller.invoke('token', 'bash', 'not-a-json', body())
    const request = execute.mock.calls[0]![0] as { settings?: unknown }
    expect(request.settings).toBeUndefined()
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
