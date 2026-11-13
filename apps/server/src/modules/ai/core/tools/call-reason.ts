import { z } from 'zod'

/**
 * **每次工具调用必填的 `reason`**（设计 §5.18）：为什么这次要用这个工具。
 *
 * 为什么由引擎注入、而不是让工具作者逐个写：
 * 1. **纪律只有一处实现**：工具会越加越多，"每个工具自己记得声明 reason、自己记得校验"靠自觉守不住；
 *    写在引擎里，以后新加的工具自动就有（标准测试集对每个注册工具断言同一条不变式）；
 * 2. **零侵入**：现有工具的执行体签名是 `input: z.infer<typeof XxxParams>`，往 `params` 里塞字段
 *    会让它们全部报类型错。所以注入发生在**给模型的 schema + 网关校验**这一层（`modelParams` /
 *    本文件），执行体拿到的 `input` 仍是原定义（`reason` 由 `ValidatePlugin` 摘掉）；
 * 3. **可审计**：`reason` 进模型入参 → 原样落 `tool-call` 时间线行 → 也进审计旁证，
 *    一眼能查到"这次为什么调它"。
 */

/** 必填字段名（前端从入参里取它渲染"为什么"那一行，禁止各处写裸字符串） */
export const TOOL_CALL_REASON_FIELD = 'reason'

/** 防空话的最短长度（"看一下""执行"这种两三个字的理由不算说明目的） */
export const TOOL_CALL_REASON_MIN = 4

/** 上限：它是给人与审计看的一句话，不该变成第二段提示词 */
export const TOOL_CALL_REASON_MAX = 200

/** 给模型看的字段说明（进 JSON Schema，模型据此填写） */
export const TOOL_CALL_REASON_DESCRIPTION =
  '为什么这次要用这个工具：一句话说明目的（用户要解决什么、这一步要达到什么）'

/**
 * 必填 `reason` 的定义（**约束给模型看的那一份**）。
 *
 * 刻意不做 `trim()` 归一化：留白串必须在 `ValidatePlugin` 里被**拒绝**（明确的纠正信号），
 * 而不是被静默改成合法值 —— 静默归一化会让模型学不会"每次都要说明理由"。
 */
export const toolCallReasonSchema = z
  .string()
  .min(TOOL_CALL_REASON_MIN, `要用一句话说明这次为什么调用它（至少 ${TOOL_CALL_REASON_MIN} 个字）`)
  .max(TOOL_CALL_REASON_MAX, `理由太长了（最多 ${TOOL_CALL_REASON_MAX} 个字），一句话说清目的即可`)
  .describe(TOOL_CALL_REASON_DESCRIPTION)

/**
 * 把一个工具的入参定义包成**给模型看的那一份**：`params.shape` + 必填 `reason`。
 *
 * - 对象型（绝大多数工具，含 `.refine()` 后的 ZodObject）：用 `.extend()` 保留字段说明与所有校验；
 * - 非对象型（理论上不该有）：退化成 `looseObject({ reason })`，让 `reason` 照旧必填、
 *   其余字段由执行体自己守（宁可这里松一点，也不能让"必填 reason"这条纪律失效）。
 */
export const withCallReason = <I>(params: z.ZodType<I>): z.ZodType<I & { reason: string }> => {
  const carrier = params as unknown as {
    shape?: Record<string, z.ZodType>
    extend?: (shape: Record<string, z.ZodType>) => z.ZodType
  }
  const injected = { [TOOL_CALL_REASON_FIELD]: toolCallReasonSchema }
  const merged =
    carrier.shape && typeof carrier.extend === 'function'
      ? carrier.extend(injected)
      : z.looseObject(injected)
  return merged as unknown as z.ZodType<I & { reason: string }>
}

/**
 * 一次调用的**校验结论**（`ValidatePlugin` 唯一消费它）。
 *
 * `input` 是**摘掉 `reason` 之后的原定义入参** —— 于是工具执行体永远看不到 `reason`，
 * 签名与行为都不变；`reason` 单独交给网关放进 `ctx.reason`。
 */
export type ToolCallCheck =
  | { ok: true; input: unknown; reason: string }
  | { ok: false; message: string }

/** 校验话术（明确可用：告诉模型"每次调用都必须说明 reason"，不是干巴巴的"入参不合法"） */
const reasonRequiredMessage = (detail: string): string =>
  `每次调用工具都必须用 reason 说明"为什么这次要用它"（一句话，${TOOL_CALL_REASON_MIN}-${TOOL_CALL_REASON_MAX} 个字，不能留空）：${detail}`

/**
 * zod 的问题列表 → 一行话术（与 `ValidatePlugin` 原话术同形）。
 *
 * 刻意不用 `z.prettifyError`：它输出多行带箭头，塞进工具错误消息里会撑成一大块；
 * 一句话一行更好读，也更好被模型"照单改"。
 */
const describeIssues = (issues: readonly z.core.$ZodIssue[]): string =>
  issues
    .map(
      (issue) => `${issue.path.map((part) => String(part)).join('.') || '(根)'}: ${issue.message}`,
    )
    .join('；')

/**
 * 校验一次调用的入参（**含必填 `reason`**），并把 `reason` 与业务入参分开。
 *
 * 顺序刻意是"先看 reason 字段本身"：
 * - 缺字段 / 非字符串 / 空白串 → 直接给 reason 专用的纠正话术（模型最容易犯的就是"忘了写"）；
 * - 给了但整份入参不合法 → 回落到通用话术（`prettifyError` 给出 zod 的标准描述）。
 */
export const checkToolCall = (
  schema: z.ZodType<{ reason: string }>,
  rawInput: unknown,
): ToolCallCheck => {
  const parsed = schema.safeParse(rawInput)
  if (!parsed.success) {
    const payload =
      rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput)
        ? (rawInput as Record<string, unknown>)
        : {}
    const value = payload[TOOL_CALL_REASON_FIELD]
    if (typeof value !== 'string')
      return { ok: false, message: reasonRequiredMessage('reason 缺失或不是字符串') }
    if (value.trim().length === 0)
      return { ok: false, message: reasonRequiredMessage('reason 不能是空白') }
    if (value.trim().length < TOOL_CALL_REASON_MIN) {
      return {
        ok: false,
        message: reasonRequiredMessage(`只说清了 ${value.trim().length} 个字，太空泛`),
      }
    }
    return { ok: false, message: `入参不合法（${describeIssues(parsed.error.issues)}）` }
  }
  /** 摘掉注入字段：执行体只应看到原定义的入参（`ToolSpec.exec` 的签名因此完全不变） */
  const { [TOOL_CALL_REASON_FIELD]: reason, ...input } = parsed.data as Record<string, unknown> & {
    reason: string
  }
  return { ok: true, input, reason }
}
