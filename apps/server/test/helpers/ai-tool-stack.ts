import { AppLogger } from '@repo/kits'
import {
  AuditEndPlugin,
  AuditStartPlugin,
  EnabledPlugin,
  PaginatePlugin,
  PrecheckPlugin,
  RateLimitPlugin,
  RedactPlugin,
  ScopePlugin,
  ValidatePlugin,
} from '../../src/modules/ai/tools/plugins/index.js'
import { ToolCallMetaStore } from '../../src/modules/ai/tools/tool.meta.js'
import { ToolResultStore } from '../../src/modules/ai/tools/tool-result.store.js'
import { systemToolClock } from '../../src/modules/ai/tools/tool.clock.js'
import { MemoryToolRateCounter } from './tool-kit-ports.js'
import { ToolConfigService } from '../../src/modules/ai/tools/tool.config.service.js'
import type { ToolConfigRow, ToolConfigSource } from '../../src/modules/ai/tools/tool.config.ports.js'
import { TOOL_CONFIG_SOURCE, TOOL_ENV_CAPS } from '../../src/modules/ai/tools/tool.config.ports.js'
import type { ToolEnvCaps } from '../../src/modules/ai/tools/tools.types.js'

/**
 * 测试用的**工具引擎装配**（设计 §5.9）：把网关 / 注册机 / 配置服务用假依赖拼起来，
 * 于是工具与插件的测试**不需要 DB、Redis、模型**。
 *
 * 与生产 `ai.module.ts` 的差别只有依赖来源：
 * - 配置来源：内存（`MemoryToolConfigSource`）而不是 `ai_tools` 表；
 * - 限流计数：内存 Map 而不是 Redis；
 * - 时钟：可控（默认真实时间，需要断言耗时时传固定值）。
 */

/** 内存版配置来源：默认"库里没有这一行"（于是走代码默认值） */
export class MemoryToolConfigSource implements ToolConfigSource {
  private readonly rows = new Map<string, ToolConfigRow>()

  /** 预置一行配置（测试里造"库里改过"的场景） */
  set(toolKey: string, row: Partial<ToolConfigRow> = {}): void {
    this.rows.set(toolKey, {
      enabled: true,
      scope: 'all',
      allowedAgents: null,
      config: null,
      limits: null,
      title: null,
      description: null,
      source: 'seed',
      version: 'test',
      secrets: null,
      ...row,
    })
  }

  async load(spec: { key: string }): Promise<ToolConfigRow | null> {
    return this.rows.get(spec.key) ?? null
  }
}

/** 测试用的假时间线（`ToolResultStore` 的兜底查询用；默认"查不到"） */
export const fakeTimelineRepository = (
  stored: Map<string, string> = new Map(),
): { findToolOutput: (conversationId: string, toolCallId: string) => Promise<string | null> } => ({
  findToolOutput: async (conversationId, toolCallId) =>
    stored.get(`${conversationId}:${toolCallId}`) ?? null,
})

/** 测试用的部署上限（与 `apps/server/src/app-config.ts` 的默认值一致） */
export const TEST_TOOL_ENV_CAPS: ToolEnvCaps = {
  pageBytesMax: 8 * 1024,
  maxPagesPerTurnMax: 5,
  command: {
    enabled: true,
    timeoutMsMax: 15_000,
    maxOutputBytesMax: 64 * 1024,
  },
}

export interface ToolStackOptions {
  /** 部署上限（默认 `TEST_TOOL_ENV_CAPS`） */
  caps?: ToolEnvCaps
  /** 配置来源（默认内存：全部走代码默认值） */
  source?: ToolConfigSource
  /** 时间线（`ToolResultStore` 的兜底） */
  timelines?: { findToolOutput: (conversationId: string, toolCallId: string) => Promise<string | null> }
  /** 插件（默认不装插件：单测工具本体时不想被开关 / 限流挡） */
  plugins?: readonly import('../../src/modules/ai/tools/tools.types.js').ToolPlugin[]
}

/**
 * 造一份最小可用的工具栈依赖（**不含注册机**）。
 *
 * 注册机要网关，网关要配置服务，配置服务要来源 —— 这个函数把后者准备好，
 * 调用方（测试）再 `new ToolGateway(...)` 与 `new ToolRegistry(...)`。
 */
export const buildToolStackDeps = (options: ToolStackOptions = {}) => {
  const source = options.source ?? new MemoryToolConfigSource()
  const caps = options.caps ?? TEST_TOOL_ENV_CAPS
  const results = new ToolResultStore(
    (options.timelines ?? fakeTimelineRepository()) as never,
  )
  const metas = new ToolCallMetaStore()
  const counter = new MemoryToolRateCounter()
  const config = new ToolConfigService(silentLogger as never, source, caps)
  /**
   * **与生产同序的插件链**（设计 §5.4）：测试要验的就是这条链，
   * 所以默认装齐 9 个（想验"没有插件时工具本体如何"再显式传 `plugins: []`）。
   */
  const plugins =
    options.plugins ??
    [
      new EnabledPlugin(),
      new ScopePlugin(),
      new RateLimitPlugin(counter, silentLogger as never),
      new ValidatePlugin(),
      new PrecheckPlugin(),
      new AuditStartPlugin(),
      new RedactPlugin(silentLogger as never),
      new PaginatePlugin(results, caps, silentLogger as never),
      new AuditEndPlugin(metas, silentLogger as never),
    ]
  return { source, caps, results, metas, counter, config, clock: systemToolClock, plugins }
}

/**
 * 造一次工具调用的上下文（工具单测直接用；不需要 Mastra）。
 *
 * 默认给一个**根 agent 的前台用户**身份（作用域 / 限流 / 审计都要它）；
 * 要测"没有信封"的分支就显式传 `caller: null` 并 `envelope: null`。
 */
export const makeToolContext = (options: {
  spec: import('../../src/modules/ai/tools/tools.types.js').ToolSpec
  settings: import('../../src/modules/ai/tools/tools.types.js').ToolSettings
  input?: unknown
  envelope?: unknown
  caller?: import('../../src/modules/ai/tools/tools.types.js').ToolCaller | null
  toolCallId?: string
}): import('../../src/modules/ai/tools/tools.types.js').ToolCallContext => ({
  spec: options.spec,
  toolKey: options.spec.key,
  toolCallId: options.toolCallId ?? 'call-test',
  caller:
    options.caller === undefined
      ? {
          conversationId: 'conv-test',
          runId: 'run-test',
          userId: 'user-test',
          isAdmin: false,
          agentKey: 'assistant',
          rootAgentKey: 'assistant',
          depth: 0,
        }
      : options.caller,
  settings: options.settings,
  envelope: options.envelope ?? null,
  log: silentLogger as never,
  clock: systemToolClock,
  rawInput: options.input,
  input: options.input,
})

/** 静默日志（测试里不关心日志；结构与 AppLogger 一致） */
export const silentLogger: Pick<AppLogger, 'debug' | 'log' | 'info' | 'warn' | 'error'> = {
  debug: () => undefined,
  log: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}
