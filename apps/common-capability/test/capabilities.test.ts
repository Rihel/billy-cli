import { describe, expect, it, vi } from 'vitest'
import type { AppLogger, Db, RedisStore, WorkspaceRuntimeService } from '@repo/kits'
import type { FileService, MemoryRepository, MemoryService } from '@repo/ai-data'
import { toRegistration } from '@repo/capability'
import { buildCommonService } from '../src/capabilities/manifest.js'
import { ToolExecutorRegistry } from '../src/executors/executor.registry.js'
import { BashExecutor } from '../src/executors/bash.executor.js'
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

const buildRegistry = (): ToolExecutorRegistry =>
  new ToolExecutorRegistry(
    new BashExecutor({ exec: vi.fn() } as unknown as WorkspaceRuntimeService, config, logger),
    new WebFetchExecutor(config, logger),
    new WebSearchExecutor(config, logger),
    new WebRequestExecutor(config, logger),
    new MemoryExecutor({} as MemoryService, {} as MemoryRepository),
    new FileExecutor({} as FileService, {}, logger),
    new ReadToolResultExecutor({} as RedisStore, {} as Db, config, logger),
  )

describe('能力声明（一个进程 = 一个服务 common）', () => {
  it('四个代码内分组聚合成 17 个能力，key 就是工具名', () => {
    const registry = buildRegistry()
    const service = buildCommonService(registry.instances())
    const registration = toRegistration(service, {
      instance: { instanceId: 'cc-1', endpoint: 'http://127.0.0.1:9994' },
    })
    const keys = registration.capabilities.map((capability) => capability.tool)

    expect(registration.service).toBe('common')
    expect(registration.source).toBe('code')
    expect(registration.protocol).toBe('capability')
    expect(keys).toHaveLength(17)
    expect(new Set(keys).size).toBe(17)
    expect(keys).toEqual([
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
    // 声明与执行体一一对应（扫描绑定，不是手抄清单）
    expect(registry.tools()).toEqual(keys)
  })

  it('能力登记与执行体同源：每条声明都带可用的入参 JSON Schema', () => {
    const registry = buildRegistry()
    const registration = toRegistration(buildCommonService(registry.instances()), {
      instance: { instanceId: 'cc-1', endpoint: 'http://127.0.0.1:9994' },
    })
    for (const capability of registration.capabilities) {
      expect(capability.inputSchema).toMatchObject({ type: 'object' })
      expect(capability.title.length).toBeGreaterThan(0)
      expect(capability.description.length).toBeGreaterThan(0)
      expect(registry.definitions().some((item) => item.tool === capability.tool)).toBe(true)
    }
    // 风险声明按能力给（不是整组一刀切）
    expect(registration.capabilities.find((item) => item.tool === 'bash')?.risk).toBe('write')
    expect(registration.capabilities.find((item) => item.tool === 'web-fetch')?.risk).toBe('read')
    expect(registration.capabilities.find((item) => item.tool === 'web-request')?.risk).toBe(
      'write',
    )
    expect(registration.capabilities.find((item) => item.tool === 'file-list')?.risk).toBe('read')
    expect(registration.capabilities.find((item) => item.tool === 'write-file')?.risk).toBe('write')
  })

  it('只有 bash 是任务形态（执行形态取自声明）', () => {
    const registry = buildRegistry()
    expect(registry.isTaskTool('bash')).toBe(true)
    expect(registry.isTaskTool('web-fetch')).toBe(false)
    const bash = registry.definitions().find((item) => item.tool === 'bash')
    expect(bash?.execution).toMatchObject({ mode: 'task', cancel: 'supported' })
  })
})
