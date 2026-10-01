import type { AiToolLimits, AiToolModel, AiToolUpdateDto } from '@repo/shared'

/**
 * 工具配置表单取值 ↔ `/ai-tool/update` 入参的转换（**纯函数**，与 React 渲染分开）。
 *
 * 两条与后端契约绑定的口径：
 * - **只提交改动过的字段**：`update` 的省略语义是"不改"，所以这里逐项与当前生效值比对，
 *   没变的字段一个都不进请求体 —— 这也顺手避免了"打开弹窗又直接保存"把秘钥之外的配置重写一遍；
 * - **秘钥三态**：留空 = 不改（不进请求体）；填了新值 = 覆盖；勾选「清空」= 提交空串。
 */

/** 编辑表单值（`config` 是整份配置：库里的值 + 代码默认值补齐） */
export type ToolFormValues = {
  enabled: boolean
  scope: string
  allowedAgents: string[]
  /** 限额：留空 = 不限制（提交时转成 null） */
  maxPerTurn?: number
  rateWindowSeconds?: number
  rateMax?: number
  pageBytes?: number
  maxPagesPerTurn?: number
  /** 工具专属配置（key = 配置键） */
  config: Record<string, unknown>
  /** 秘钥输入框（留空 = 不改） */
  secrets: Record<string, string>
  /** 勾选 = 提交空串清空该秘钥（与"留空 = 不改"区分开） */
  clearSecrets: Record<string, boolean>
}

/** 表单初值：编辑某个工具时用它回填 */
export const toFormValues = (tool: AiToolModel): ToolFormValues => {
  const limits = tool.limits ?? {}
  return {
    enabled: tool.enabled,
    scope: tool.scope,
    allowedAgents: [...tool.allowedAgents],
    maxPerTurn: limits.maxPerTurn ?? undefined,
    rateWindowSeconds: limits.rateLimit?.windowSeconds,
    rateMax: limits.rateLimit?.max,
    pageBytes: limits.pageBytes ?? undefined,
    maxPagesPerTurn: limits.maxPagesPerTurn ?? undefined,
    config: { ...tool.config },
    secrets: Object.fromEntries(tool.secretFields.map((field) => [field.name, ''])),
    clearSecrets: Object.fromEntries(tool.secretFields.map((field) => [field.name, false])),
  }
}

/** 构建结果：`dto` 为 null 表示没有任何改动 */
export type BuildToolUpdateResult =
  | { ok: true; dto: AiToolUpdateDto | null }
  | { ok: false; error: string }

/** 限额归一化：统一成"给了值 / null（不限制）"，用于比对与提交 */
const normalizeLimits = (limits: AiToolLimits): AiToolLimits => ({
  maxPerTurn: limits.maxPerTurn ?? null,
  rateLimit: limits.rateLimit ?? null,
  pageBytes: limits.pageBytes ?? null,
  maxPagesPerTurn: limits.maxPagesPerTurn ?? null,
})

/** 表单值 → 归一化限额（窗口秒数与上限必须一起给） */
const limitsFromValues = (values: ToolFormValues): AiToolLimits => ({
  maxPerTurn: values.maxPerTurn ?? null,
  rateLimit:
    values.rateWindowSeconds !== undefined && values.rateMax !== undefined
      ? { windowSeconds: values.rateWindowSeconds, max: values.rateMax }
      : null,
  pageBytes: values.pageBytes ?? null,
  maxPagesPerTurn: values.maxPagesPerTurn ?? null,
})

/** 数组是否逐项相同（顺序敏感：agent 清单的顺序就是表单里的顺序） */
const sameStringArray = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((item, index) => item === right[index])

/** 复杂配置项（对象 / 数组）在兜底面板里用 JSON 文本编辑，提交前解析回结构化值 */
const coerceConfigValue = (
  key: string,
  defaultValue: unknown,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } => {
  const isComplexDefault = defaultValue !== null && typeof defaultValue === 'object'
  if (!isComplexDefault || typeof value !== 'string') return { ok: true, value }
  try {
    return { ok: true, value: JSON.parse(value) }
  } catch {
    return { ok: false, error: `配置项「${key}」是复杂结构，请输入合法的 JSON` }
  }
}

/**
 * 构建 `update` 入参：逐项与当前生效值比对，只带上改动过的字段。
 *
 * 校验也在这里做（因为它依赖表单的整体值，不是单字段规则）：
 * 作用域为「指定 agent」时必须至少给一个 agent；限流的窗口秒数与上限必须一起填。
 */
export const buildToolUpdatePayload = (
  tool: AiToolModel,
  values: ToolFormValues,
): BuildToolUpdateResult => {
  if (values.scope === 'agent' && values.allowedAgents.length === 0) {
    return { ok: false, error: '作用域为「指定 agent」时，至少要指定一个 agent' }
  }
  const windowGiven = values.rateWindowSeconds !== undefined
  const maxGiven = values.rateMax !== undefined
  if (windowGiven !== maxGiven) {
    return { ok: false, error: '限流的「窗口秒数」与「窗口内上限次数」要一起填，或都留空' }
  }

  const dto: AiToolUpdateDto = { toolKey: tool.toolKey }

  if (values.enabled !== tool.enabled) dto.enabled = values.enabled
  if (values.scope !== tool.scope) dto.scope = values.scope
  if (!sameStringArray(values.allowedAgents, tool.allowedAgents)) {
    dto.allowedAgents = values.allowedAgents
  }

  const limits = limitsFromValues(values)
  if (JSON.stringify(limits) !== JSON.stringify(normalizeLimits(tool.limits ?? {}))) {
    dto.limits = limits
  }

  const config: Record<string, unknown> = {}
  let configChanged = false
  for (const [key, value] of Object.entries(values.config)) {
    const coerced = coerceConfigValue(key, tool.defaultConfig[key], value)
    if (!coerced.ok) return { ok: false, error: coerced.error }
    config[key] = coerced.value
    if (JSON.stringify(coerced.value) !== JSON.stringify(tool.config[key])) {
      configChanged = true
    }
  }
  // 工具配置是**整列替换**（后端把 `ai_tools.config` 整份覆盖，不按 key 合并）：
  // 一旦有改动就提交整份生效值 —— 只提交改过的那几个键会把其它覆盖值悄悄抹掉、回到代码默认。
  if (configChanged) dto.config = config

  const secrets: Record<string, string> = {}
  for (const field of tool.secretFields) {
    if (values.clearSecrets[field.name]) {
      // 勾了清空就以清空为准（此时输入框是禁用的，里面残留的旧文本不算数）
      secrets[field.name] = ''
      continue
    }
    const typed = (values.secrets[field.name] ?? '').trim()
    if (typed) secrets[field.name] = typed
  }
  if (Object.keys(secrets).length > 0) dto.secrets = secrets

  const changed =
    dto.enabled !== undefined ||
    dto.scope !== undefined ||
    dto.allowedAgents !== undefined ||
    dto.limits !== undefined ||
    dto.config !== undefined ||
    dto.secrets !== undefined
  return { ok: true, dto: changed ? dto : null }
}
