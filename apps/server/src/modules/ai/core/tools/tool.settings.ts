import type { AnyToolSpec, ToolEnvCaps, ToolLimits, ToolSettings, ToolSpec } from './tools.types.js'
import { hintOf } from '../../../ai-model/secret-hint.js'
import { toAiToolEventModels } from './tool-event.js'
import type { ToolConfigRow } from './tool.config.ports.js'

/**
 * 工具配置的**合并规则**（纯函数，设计 §5.5）—— 与"读库 / 缓存"分开，可脱离 DB 单测。
 *
 * 生效值三级：
 *
 * ```
 * 生效值 = env 硬上限 夹紧 ( 库里的值 ?? spec.config.parse({}) 的默认值 )
 * ```
 *
 * 三条口径：
 * - **代码默认值来自 schema**（`config.parse({})`），不单列 `defaults`，否则必然漂移；
 * - **库里的配置允许稀疏**：只补它给了的字段（`{...defaults, ...row.config}`）；
 * - **秘钥没有默认值**：缺就是"未配置"，由 `precheck` 给结论；提示串**读取时从明文派生**
 *   （明文入库是工程取舍，2026-10-01 决定）。
 */

/** 代码默认值：`spec.config.parse({})`。失败说明这个工具的默认值没给全 —— 启动期就该炸 */
export const codeDefaults = <C>(spec: ToolSpec<C> | AnyToolSpec): C => {
  const parsed = spec.config.safeParse({})
  if (!parsed.success) {
    throw new Error(
      `工具 ${spec.key} 的配置没有给全默认值：spec.config.parse({}) 失败 —— ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
        .join('；')}`,
    )
  }
  return parsed.data
}

/** 限额夹紧（DB 值不得超过 env 上限） */
export const clampLimits = (limits: ToolLimits, caps: ToolEnvCaps): ToolLimits => ({
  maxPerTurn:
    typeof limits.maxPerTurn === 'number' && limits.maxPerTurn > 0
      ? Math.floor(limits.maxPerTurn)
      : null,
  rateLimit: limits.rateLimit ?? null,
  pageBytes:
    typeof limits.pageBytes === 'number' && limits.pageBytes > 0
      ? Math.min(Math.floor(limits.pageBytes), caps.pageBytesMax)
      : null,
  maxPagesPerTurn:
    typeof limits.maxPagesPerTurn === 'number' && limits.maxPagesPerTurn > 0
      ? Math.min(Math.floor(limits.maxPagesPerTurn), caps.maxPagesPerTurnMax)
      : null,
})

/**
 * 合并出一次调用要用的生效配置。
 *
 * `normalize`（可选）是工具自己的夹紧钩子（如 `bash` 把时长 / 输出夹到部署上限），
 * 在合并之后、落 `settings.config` 之前执行 —— 于是"工具看到的配置"永远已经是安全取值。
 */
export const mergeToolSettings = <C>(
  spec: ToolSpec<C> | AnyToolSpec,
  row: ToolConfigRow | null,
  caps: ToolEnvCaps,
): ToolSettings<C> => {
  const defaults = codeDefaults(spec)
  const stored = row?.config ?? {}
  // 稀疏合并：只覆盖库里给了的键（`undefined` 视为没给，避免把默认值抹掉）
  const given = Object.fromEntries(
    Object.entries(stored).filter(([, value]) => value !== undefined),
  )
  const merged = { ...(defaults as Record<string, unknown>), ...given } as C
  const normalized = spec.normalize ? spec.normalize(merged, caps) : merged
  return {
    key: spec.key,
    // 覆盖文案：空串 / 全空白视为"没覆盖"（回到代码声明），有值就用**去掉首尾空白**的值
    title: row?.title?.trim() ? row.title.trim() : spec.title,
    description: row?.description?.trim() ? row.description.trim() : spec.description,
    enabled: row?.enabled ?? true,
    scope: (row?.scope ?? spec.scope) as ToolSettings['scope'],
    allowedAgents: row?.allowedAgents ?? [],
    config: normalized,
    limits: clampLimits((row?.limits ?? {}) as ToolLimits, caps),
    source: row?.source === 'manual' ? 'manual' : 'seed',
    paramSchema: row?.paramSchema ?? null,
    // 事件声明的镜像：库里没有（老行 / 还没同步）就用代码声明现算一次兜底
    events: row?.events && row.events.length > 0 ? row.events : toAiToolEventModels(spec.events),
    version: row?.version ?? 'code-default',
    secret: (name) => row?.secrets?.[name] ?? null,
    // 提示串从明文派生：库里不存提示列，"配的是哪一把"永远与明文一致
    secretHint: (name) => {
      const plain = row?.secrets?.[name]
      return plain ? hintOf(plain) : null
    },
  }
}
