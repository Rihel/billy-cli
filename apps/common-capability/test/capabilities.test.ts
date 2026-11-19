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
    new FileExecutor({} as FileService, {}, logger, { workspaceIdOf: async () => null } as never),
    new ReadToolResultExecutor({} as RedisStore, {} as Db, config, logger),
  )

describe('能力声明（一个进程 = 一个服务 common）', () => {
  it('只登记 host 类能力（9 个）；workspace 类由 workspace-service 登记', () => {
    const registry = buildRegistry()
    const service = buildCommonService(registry.instances())
    const registration = toRegistration(service, {
      instance: { instanceId: 'cc-1', endpoint: 'http://127.0.0.1:9994' },
    })
    const keys = registration.capabilities.map((capability) => capability.tool)

    expect(registration.service).toBe('common')
    expect(registration.source).toBe('code')
    expect(registration.protocol).toBe('capability')
    expect(keys).toHaveLength(9)
    expect(new Set(keys).size).toBe(9)
    expect(keys).toEqual([
      'web-fetch',
      'web-search',
      'web-request',
      'memory-save',
      'memory-search',
      'memory-forget',
      'file-submit',
      'file-download',
      'read-tool-result',
    ])
    // 能力是执行器的子集（扫描绑定，不手抄清单）；workspace 类执行器仍在 registry 里
    expect(keys.every((key) => registry.tools().includes(key))).toBe(true)
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
    // workspace 类能力由 workspace-service 登记，common 只登记 host 类
    expect(registration.capabilities.some((item) => item.tool === 'bash')).toBe(false)
    expect(registration.capabilities.some((item) => item.tool === 'file-list')).toBe(false)
    // 风险声明按能力给（不是整组一刀切）
    expect(registration.capabilities.find((item) => item.tool === 'web-fetch')?.risk).toBe('read')
    expect(registration.capabilities.find((item) => item.tool === 'web-request')?.risk).toBe(
      'write',
    )
  })

  it('只有 bash 是任务形态（执行形态取自声明）', () => {
    const registry = buildRegistry()
    expect(registry.isTaskTool('bash')).toBe(true)
    expect(registry.isTaskTool('web-fetch')).toBe(false)
    const bash = registry.definitions().find((item) => item.tool === 'bash')
    expect(bash?.execution).toMatchObject({ mode: 'task', cancel: 'supported' })
  })
})
