import { z } from 'zod'
import { connectorToolKey } from './connector.keys.js'
import type { Capability, ConnectorDriver, ConnectorRuntime } from './connector.types.js'
import { ToolDeniedError } from '../core/tools/tools.types.js'
import type { AnyToolSpec, ToolCallContext } from '../core/tools/tools.types.js'

/**
 * **连接器能力 → 我们的工具**（设计 `docs/design/ai-connector.md` §3.5）。
 *
 * 一条纯函数：给它实例、驱动、能力和运行时，产出一份 `ToolSpec`。
 * 它不写库、不注册、不碰 Mastra——那三件事分别归同步服务、注册机、适配器。
 */

export type ToolCapability = Extract<Capability, { kind: 'tool' }>

/** 能力描述里的 JSON Schema → 入参校验（zod 4 的 `fromJSONSchema`；转不动就降级为任意对象） */
export const inputSchemaToZod = (schema?: Record<string, unknown> | null): z.ZodType => {
  if (!schema || Object.keys(schema).length === 0) return z.record(z.string(), z.unknown())
  try {
    const fromJsonSchema = (
      z as unknown as { fromJSONSchema: (raw: unknown) => z.ZodType }
    ).fromJSONSchema
    return fromJsonSchema(schema)
  } catch {
    return z.record(z.string(), z.unknown())
  }
}

/** 连接器工具的 key：`c-<实例 key>-<工具名>`（≤64），只当可读约定 */
export const toolKeyOf = (connectorKey: string, toolName: string): string =>
  connectorToolKey(connectorKey, toolName)

/** 工具说明的最大长度（前缀缓存每轮都带，别写太长） */
const MAX_DESCRIPTION = 900

/**
 * 生成一份连接器工具的声明。
 *
 * 三条口径：
 * - **治理挂在工具行上**：默认 `scope='admin'`（数据库这类能力默认只给管理员对话），
 *   要放开给前台就在 `/ai-tool/*` 里改；
 * - **密钥来自连接器实例**，不落 `ai_tools`；`secretFields` 只用于页面提示与出参脱敏；
 * - **说明带来源前缀**，让模型与人都看得出"这个工具属于哪家服务"。
 */
export const toConnectorToolSpec = (
  instance: { id: string; key: string; name: string },
  driver: ConnectorDriver,
  capability: ToolCapability,
  runtime: ConnectorRuntime,
): AnyToolSpec => {
  const description = `【连接器：${instance.name}】${capability.description}`.slice(0, MAX_DESCRIPTION)

  return {
    key: toolKeyOf(instance.key, capability.name),
    title: capability.title,
    description,
    category: 'connector',
    params: inputSchemaToZod(capability.inputSchema),
    // 配置在连接器行上，工具行不再重复
    config: z.object({}),
    secrets: z.record(z.string(), z.string().optional()),
    secretFields: driver.secrets
      .filter((field) => field.secret)
      .map((field) => ({ name: field.key, label: field.label, required: field.required ?? false })),
    events: [],
    // 来源交给网关的 connector-guard 做总闸（实例停用 / 缺密钥）
    connector: { id: instance.id, key: instance.key, toolName: capability.name },
    scope: 'admin',
    // 连接器出参（SQL 结果 / CLI stdout / 技能文档）都可能很大：统一按页给模型，全量仍入库
    paginate: { pageBytes: 8 * 1024 },
    async exec(input: unknown, ctx: ToolCallContext) {
      // 用户点停止 / 这一轮结束时把信号带进驱动（CLI 这类长命令能及时被杀掉）
      const callRuntime = ctx.signal ? { ...runtime, signal: ctx.signal } : runtime
      try {
        return await driver.invoke(callRuntime, capability.name, input)
      } catch (error) {
        // 驱动自己的拒绝（只读、越界、类型不对）原样透传；其余一律算"外部服务不可用"，
        // 不能落成 internal —— 那是"我们写错了"，会让排障与告警说两套话。
        if (error instanceof ToolDeniedError) throw error
        throw new ToolDeniedError(
          'upstream',
          `调用「${instance.name}」失败：${error instanceof Error ? error.message : String(error)}`,
          '检查服务状态或稍后重试；持续失败把这句话告诉用户',
        )
      }
    },
  } as AnyToolSpec
}
