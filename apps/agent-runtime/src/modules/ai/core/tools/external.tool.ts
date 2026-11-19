import { z } from 'zod'
import type { CapabilityInfo } from '@repo/contracts'
import type { AgentRuntimeEnvelope } from '../envelope.js'
import { withCallReason } from './call-reason.js'
import { toCaller } from './tool.caller.js'
import type { RemoteToolInvoker } from './tool.ports.js'
import { ToolDeniedError } from './tools.types.js'
import type { Tool, ToolCallInput, ToolOutcome, ToolSpec } from './tools.types.js'

/**
 * **能力目录里的工具**（不在本进程注册机里的能力）。
 *
 * 两类来源，执行路径相同（都走能力网关），差别只在“什么时候给模型看到”：
 * - `source='code'`（内部服务 / 网关内建）：随工具面一起给，提示词里也列；
 * - `source='manual'`（MCP / 外部登记服务）：只有被 `tool-search` 搜到过，
 *   才在**下一轮**补进工具面（避免每次请求都背全部外部工具定义）。
 *
 * 为什么临时造 `ToolSpec` 而不是进注册机：注册机只认代码声明（种子同步也只喂代码声明），
 * 目录是运行期数据，随登记 / 授权变化。
 */

/** JSON Schema → zod（转不动就退成任意对象） */
export const externalParamsOf = (schema: Record<string, unknown>): z.ZodType => {
  const converter = (z as unknown as { fromJSONSchema?: (raw: unknown) => z.ZodType })
    .fromJSONSchema
  if (!converter) return z.record(z.string(), z.unknown())
  try {
    return converter(schema)
  } catch {
    return z.record(z.string(), z.unknown())
  }
}

export const createCapabilityTool = (
  capability: CapabilityInfo,
  remote: RemoteToolInvoker | null,
): Tool => {
  const params = externalParamsOf(capability.inputSchema)
  const spec: ToolSpec = {
    key: capability.key,
    title: capability.title,
    description: capability.description,
    category: capability.source === 'code' ? 'core' : 'external',
    params,
    // 与本地工具同一口径：每次调用必须说明“为什么用它”（执行前会剥掉，不进能力入参）
    modelParams: withCallReason(params),
    config: z.object({}),
    events: [],
    scope: 'all',
    exec: async () => {
      // 正常路径走 Tool.run → 网关；这里只是 DSL 的类型兜底，不该被调用
      throw new ToolDeniedError('disabled', '目录能力必须经能力网关执行')
    },
  }
  return {
    key: capability.key,
    spec,
    async run(rawInput: unknown, call: ToolCallInput): Promise<ToolOutcome> {
      if (!remote) {
        return {
          ok: false,
          reason: 'disabled',
          message: '未配置能力网关，目录能力不可用',
          retryable: false,
        }
      }
      const caller = toCaller((call.envelope ?? null) as AgentRuntimeEnvelope | null)
      if (!caller) {
        return {
          ok: false,
          reason: 'forbidden',
          message: '缺少调用方身份，不能执行目录能力',
          retryable: false,
        }
      }
      const raw =
        rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
          ? (rawInput as Record<string, unknown>)
          : {}
      // `reason` 是工具面的协议字段，不属于能力入参：网关按能力 schema 校验会判 Unrecognized key
      const { reason: _reason, ...input } = raw
      return remote.invoke({
        toolKey: capability.key,
        toolCallId: call.callId,
        input,
        caller,
        deadlineMs: 310_000,
      })
    },
  }
}
