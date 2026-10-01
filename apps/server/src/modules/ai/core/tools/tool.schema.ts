import type { AnyToolSpec } from './tools.types.js'

/**
 * 参数契约 → JSON Schema（仅供后台页**只读展示**：让管理员看到"模型眼里的入参长什么样"）。
 *
 * 转不出来不抛错：自定义 schema 转不出来只影响展示位，不该让整个后台页失败。
 */
export const toJsonSchema = (spec: AnyToolSpec): Record<string, unknown> | null => {
  try {
    const schema = spec.params as unknown as { toJSONSchema?: () => Record<string, unknown> }
    return typeof schema.toJSONSchema === 'function' ? schema.toJSONSchema() : null
  } catch {
    return null
  }
}
