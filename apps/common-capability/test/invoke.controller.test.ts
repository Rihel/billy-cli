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
    const response = await controller.invoke('token', 'bash', body())

    expect(execute).toHaveBeenCalledTimes(1)
    const request = execute.mock.calls[0]![0] as { toolKey: string; input: unknown }
    expect(request.toolKey).toBe('bash')
    expect(request.input).toEqual({ command: 'echo hi' })
    expect(response).toMatchObject({ version: 1, ok: true, data: { stdout: 'hi' } })
  })

  it('业务失败也是 HTTP 200 的三形态之一', async () => {
    const { controller } = build({
      ok: false,
      reason: 'sandbox-unavailable',
      message: '沙箱不可用',
      retryable: false,
    })
    const response = await controller.invoke('token', 'bash', body())
    expect(response).toMatchObject({
      version: 1,
      ok: false,
      reason: 'sandbox-unavailable',
      message: '沙箱不可用',
    })
  })

  it('不认识的工具返回 unknown-tool，不进执行器', async () => {
    const { controller, execute } = build()
    const response = await controller.invoke('token', 'exec/nope', body({ tool: 'nope' }))
    expect(response).toMatchObject({ ok: false, reason: 'unknown-tool' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('令牌不对直接 403', async () => {
    const { controller } = build()
    await expect(controller.invoke('bad', 'bash', body())).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('body 不合法直接 400', async () => {
    const { controller } = build()
    await expect(controller.invoke('token', 'bash', { version: 1 })).rejects.toThrow('不合法')
  })
})
