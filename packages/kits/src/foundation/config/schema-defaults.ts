import _ from 'lodash'

/**
 * 提取 Zod schema 中声明的默认值，得到一棵「默认值对象树」，用于在 parse 之前
 * 与来源数据做 `_.defaultsDeep` 合并。
 *
 * 为什么需要它：Zod 的 `parse()` 只在**父键存在**时补全嵌套对象的默认值；
 * 若配置来源完全没有 `redis` 这个键，`z.object({ redis: RedisConfigSchema }).parse({})`
 * 会直接报 `invalid_type: expected object, received undefined`，而不是用 `redis` 的默认值。
 * 因此必须先按 schema 把缺失的嵌套对象物化出来。
 *
 * 实现说明：
 * - 按 Zod 4 的 `schema.def.type` 判别（`default` / `object` / `optional` / `nullable` /
 *   `readonly` / `pipe`）；Zod 3 的 `z.ZodDefault` 等类在 v4 已不存在；
 * - **`optional` 不参与物化**：可选分支「未提供」就是未提供（若把 `notify.lark` 补成 `{}`，
 *   下游会误判该通道已配置）。可选对象一旦真的提供，Zod 自身仍会补全其内层默认值。
 * - 未知 / 无法识别的类型一律返回 undefined（只跳过，不报错），保证对 schema 演进友好。
 */
export const zodSchemaDefaults = (schema: unknown): unknown => {
  const def = (schema as { def?: Record<string, unknown> } | undefined)?.def
  if (!def || typeof def.type !== 'string') return undefined

  switch (def.type) {
    case 'default': {
      const value = def.defaultValue
      return typeof value === 'function' ? (value as () => unknown)() : value
    }

    case 'object': {
      const shape = def.shape as Record<string, unknown> | undefined
      if (!shape || typeof shape !== 'object') return undefined

      const result: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(shape)) {
        const value = zodSchemaDefaults(child)
        if (value !== undefined) result[key] = value
      }
      return result
    }

    case 'nullable':
    case 'readonly':
      return zodSchemaDefaults(def.innerType)

    /** Zod 4 的 `.transform()` / `.pipe()` 用 pipe 类型串联，默认值在内侧 */
    case 'pipe':
      return zodSchemaDefaults(def.in ?? def.innerType)

    /** 可选分支不物化（见上方说明） */
    case 'optional':
    default:
      return undefined
  }
}

/** 把 schema 默认值合并进来源数据（来源优先，缺失键用默认值补齐；不修改入参） */
export const mergeSchemaDefaults = <T extends Record<string, unknown>>(
  data: T,
  schema: unknown,
): T => {
  const defaults = zodSchemaDefaults(schema)
  if (defaults === undefined) return data
  return _.defaultsDeep({}, data, defaults) as T
}
