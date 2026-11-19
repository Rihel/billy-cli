import { describe, expect, it, vi } from 'vitest'
import type { AppLogger, Db, RedisStore, WorkspaceRuntimeService } from '@repo/kits'
import type { FileService, MemoryRepository, MemoryService } from '@repo/ai-data'
import type { ToolInvokeRequest } from '@repo/contracts'
import { BashExecutor } from '../src/executors/bash.executor.js'
import { ToolExecutorRegistry } from '../src/executors/executor.registry.js'
import { WebFetchExecutor } from '../src/tools/web/web-fetch.executor.js'
import { WebSearchExecutor } from '../src/tools/web/web-search.executor.js'
import { WebRequestExecutor } from '../src/tools/web/web-request.executor.js'
import { MemoryExecutor } from '../src/tools/memory/memory.executor.js'
import { FileExecutor } from '../src/tools/file/file.executor.js'
import { ReadToolResultExecutor } from '../src/tools/read-tool-result.executor.js'
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
  workspaceRoot: '/tmp/billy-common-capability-test',
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

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger
const runtime = { exec: vi.fn() } as unknown as WorkspaceRuntimeService
const locator = { workspaceIdOf: vi.fn(async () => 'ws-1') }
const client = {
  exec: runtime.exec,
} as unknown as import('@repo/internal-sdk').WorkspaceServiceClient

const request = (toolKey: string): ToolInvokeRequest => ({
  version: 1,
  requestId: 'req-1',
  toolKey,
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
})

describe('ToolExecutorRegistry', () => {
  it('注册 bash，并按 key 分发', async () => {
    const registry = new ToolExecutorRegistry(
      new BashExecutor(locator as never, client, config, logger),
      new WebFetchExecutor(config, logger),
      new WebSearchExecutor(config, logger),
      new WebRequestExecutor(config, logger),
      new MemoryExecutor({} as MemoryService, {} as MemoryRepository),
      new FileExecutor({} as FileService, {}, logger, { workspaceIdOf: async () => null } as never),
      new ReadToolResultExecutor({} as RedisStore, {} as Db, config, logger),
    )
    // 顺序 = 各执行器里 @CapabilityDecl 的声明顺序（扫描绑定，不手抄清单）
    expect(registry.tools()).toEqual([
      'bash',
      'web-fetch',
      'web-search',
      'web-request',
      'memory-save',
      'memory-search',
      'memory-forget',
      'file-list',
      'read-file',
      'write-file',
      'append-file',
      'replace-file',
      'file-search',
      'file-submit',
      'file-download',
      'workspace-files',
      'read-tool-result',
    ])
    await registry.get('bash')!.execute(request('bash'))
    expect(runtime.exec).toHaveBeenCalled()
  })

  it('未注册的工具返回 undefined（由 service 翻成 unsupported-tool）', () => {
    const registry = new ToolExecutorRegistry(
      new BashExecutor(locator as never, client, config, logger),
      new WebFetchExecutor(config, logger),
      new WebSearchExecutor(config, logger),
      new WebRequestExecutor(config, logger),
      new MemoryExecutor({} as MemoryService, {} as MemoryRepository),
      new FileExecutor({} as FileService, {}, logger, { workspaceIdOf: async () => null } as never),
      new ReadToolResultExecutor({} as RedisStore, {} as Db, config, logger),
    )
    expect(registry.get('plan-create')).toBeUndefined()
  })
})
