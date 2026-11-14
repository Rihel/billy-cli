import { describe, expect, it, vi } from 'vitest'
import type { AppLogger, WorkspaceRuntimeService } from '@repo/kits'
import type { ToolInvokeRequest } from '@repo/contracts'
import { BashExecutor } from '../src/executors/bash.executor.js'
import { ToolExecutorRegistry } from '../src/executors/executor.registry.js'
import { WebFetchExecutor } from '../src/tools/web/web-fetch.executor.js'
import { WebSearchExecutor } from '../src/tools/web/web-search.executor.js'
import { WebRequestExecutor } from '../src/tools/web/web-request.executor.js'
import { MemoryExecutor } from '../src/tools/memory/memory.executor.js'
import { FileExecutor } from '../src/tools/file/file.executor.js'
import { ReadToolResultExecutor } from '../src/tools/read-tool-result.executor.js'
import { ToolWorkerService } from '../src/worker.service.js'
import type { ToolWorkerConfigValue } from '../src/config/app-config.js'

const config: ToolWorkerConfigValue = {
  id: 'w-test',
  version: '0.1.0',
  zone: 'test',
  endpoint: 'http://127.0.0.1:9994',
  internalToken: 'token',
  heartbeatIntervalMs: 10_000,
  staleAfterMs: 30_000,
  maxConcurrency: 2,
  workspaceRoot: '/tmp/billy-tool-worker-test',
  commandTimeoutMs: 15_000,
  maxOutputBytes: 64 * 1024,
  web: {
    timeoutMs: 20_000,
    maxBytes: 2 * 1024 * 1024,
    pageLines: 1000,
    cacheTtlMs: 30 * 60_000,
    allowPrivateNetwork: false,
  },
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as AppLogger

const request = (over: Partial<ToolInvokeRequest> = {}): ToolInvokeRequest => ({
  version: 1,
  requestId: 'req-1',
  toolKey: 'bash',
  toolCallId: 'call-1',
  input: { command: 'echo hi' },
  caller: {
    conversationId: 'c-1',
    runId: 'r-1',
    userId: 'u-1',
    agentKey: 'assistant',
    rootAgentKey: 'assistant',
    depth: 0,
  },
  deadlineMs: 10_000,
  ...over,
})

const build = (exec = vi.fn()) => {
  exec.mockResolvedValue({
    ok: true,
    command: 'echo hi',
    shell: '/bin/sh',
    cwd: '/tmp/billy-tool-worker-test/c-1',
    exitCode: 0,
    stdout: 'hi\n',
    stderr: '',
    timedOut: false,
    aborted: false,
    truncated: false,
    durationMs: 3,
    runtime: 'sandbox',
    mode: 'workspace-write',
  })
  const runtime = { exec } as unknown as WorkspaceRuntimeService
  return {
    service: new ToolWorkerService(
      new ToolExecutorRegistry(
        new BashExecutor(runtime, config, logger),
        new WebFetchExecutor(config, logger),
        new WebSearchExecutor(config, logger),
        new WebRequestExecutor(config, logger),
        new MemoryExecutor(config, logger),
        new FileExecutor(config, logger),
        new ReadToolResultExecutor(config, logger),
      ),
      logger,
    ),
    exec,
  }
}

describe('ToolWorkerService：bash 执行', () => {
  it('把命令放进本会话临时工作区，并夹紧超时', async () => {
    const { service, exec } = build()
    const outcome = await service.execute(
      request({ input: { command: 'echo hi', timeout_ms: 60_000 }, deadlineMs: 60_000 }),
    )

    expect(outcome.ok).toBe(true)
    expect(exec).toHaveBeenCalledTimes(1)
    const arg = exec.mock.calls[0]![0] as {
      cwd: string
      workspaceRoot: string
      timeoutMs: number
      maxOutputBytes: number
    }
    expect(arg.workspaceRoot).toBe('/tmp/billy-tool-worker-test/c-1')
    expect(arg.cwd).toBe('/tmp/billy-tool-worker-test/c-1')
    expect(arg.timeoutMs).toBe(15_000)
    expect(arg.maxOutputBytes).toBe(64 * 1024)
  })

  it('拒绝越界 cwd / 非法会话 id / 非法参数', async () => {
    const { service, exec } = build()

    await expect(
      service.execute(request({ input: { command: 'echo hi', cwd: '../../etc' } })),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid-input' })
    await expect(
      service.execute(request({ caller: { ...request().caller, conversationId: '../x' } })),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid-input' })
    await expect(service.execute(request({ input: { command: '' } }))).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-input',
    })
    expect(exec).not.toHaveBeenCalled()
  })

  it('不认识的工具直接拒绝，不进执行器', async () => {
    const { service, exec } = build()
    await expect(service.execute(request({ toolKey: 'plan-create' }))).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-tool',
    })
    expect(exec).not.toHaveBeenCalled()
  })
})
