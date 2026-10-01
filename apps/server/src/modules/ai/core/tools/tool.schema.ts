import type { AnyToolSpec } from './tools.types.js'

/**
 * 参数契约 → JSON Schema（后台页**只读展示** + 模型侧契约的镜像：让管理员看到"模型眼里的入参长什么样"）。
 *
 * 刻意取 `modelParams`（`params` + 引擎注入的必填 `reason`，见 `call-reason.ts`）：
 * 后台展示必须与模型实际拿到的那一份一致，否则"入参契约"这一栏会少一个必填字段，管理员无从解释
 * "模型为什么被要求写 reason"。`modelParams` 缺失（测试替身）时回落到 `params`。
 *
 * 转不出来不抛错：自定义 schema 转不出来只影响展示位，不该让整个后台页失败。
 */
export const toJsonSchema = (spec: AnyToolSpec): Record<string, unknown> | null => {
  try {
    const schema = (spec.modelParams ?? spec.params) as unknown as {
      toJSONSchema?: () => Record<string, unknown>
    }
    return typeof schema.toJSONSchema === 'function' ? schema.toJSONSchema() : null
  } catch {
    return null
  }
}
