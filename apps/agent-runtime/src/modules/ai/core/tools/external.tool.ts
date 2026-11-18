import { z } from 'zod'
import type { CapabilityInfo } from '@repo/contracts'
import type { AgentRuntimeEnvelope } from '../envelope.js'
import { toCaller } from './tool.caller.js'
import type { RemoteToolInvoker } from './tool.ports.js'
import { ToolDeniedError } from './tools.types.js'
import type { Tool, ToolCallInput, ToolOutcome, ToolSpec } from './tools.types.js'

/**
 * **外部工具**（能力目录里、本地注册机没声明的那些：MCP / 外部登记服务）。
 *
 * 为什么在装配期临时造 `ToolSpec` 而不是进注册机：这些工具随「登记 + 能力清单」变化，
 * 不是代码声明；注册机只认代码（种子同步也只喂代码声明）。
 *
 * 执行一律走 `RemoteToolInvoker` → 能力网关（治理、审计、凭据都在网关），本地不跑插件链。
 */

/** JSON Schema → zod（转不动就退成任意对象；与连接器时代的同一策略） */
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

export const createExternalTool = (
  capability: CapabilityInfo,
  remote: RemoteToolInvoker | null,
): Tool => {
  const params = externalParamsOf(capability.inputSchema)
  const spec: ToolSpec = {
    key: capability.key,
    title: capability.title,
    description: capability.description,
    category: 'external',
    params,
    config: z.object({}),
    events: [],
    scope: 'all',
    exec: async () => {
      // 正常路径走 Tool.run → 网关；这里只是 DSL 的类型兜底，不该被调用
      throw new ToolDeniedError('disabled', '外部工具必须经能力网关执行')
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
          message: '未配置能力网关，外部工具不可用',
          retryable: false,
        }
      }
      const caller = toCaller((call.envelope ?? null) as AgentRuntimeEnvelope | null)
      if (!caller) {
        return {
          ok: false,
          reason: 'forbidden',
          message: '缺少调用方身份，不能执行外部工具',
          retryable: false,
        }
      }
      const input =
        rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
          ? (rawInput as Record<string, unknown>)
          : {}
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
