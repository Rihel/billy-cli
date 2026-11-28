/**
 * **Mastra 错误 → 给人 / 给模型看的结论文本**（适配器，设计 §5.8）。
 *
 * 为什么必须有这一层：`@mastra/ai-sdk` 把工具错误（`tool-error`）与整轮错误（`error`）转成
 * UI 片段时，`errorText` 的**默认实现是 `JSON.stringify(error)`**（`safeParseErrorObject`）。
 * 平时看不出来，因为 `Error` 的 `name` / `message` / `stack` 不可枚举、`JSON.stringify` 会得到 `"{}"`
 * 而退化成 `String(error)`；但只要事件过一次 durable 步骤，错误就被序列化成**普通对象**
 * `{ name, message, stack }` 再回来 —— 于是错误卡片里出现整段 JSON 与一长串
 * `@mastra/core` 内部堆栈（2026-10 用户反馈："为啥错误直接把这个 json 和堆栈都弄出来了"）。
 *
 * 口径：**错误卡片只放结论**（原因 + 提示），堆栈留在服务端日志；模型看到的也是同一份文本，
 * 不会因为一屏堆栈浪费 token。本函数只取 `message`，永不返回 `stack`、永不返回 JSON。
 *
 * 两种错误形态实测（`durable` 关 / 开）：
 * - 关：`MastraError(id=TOOL_EXECUTION_FAILED)` → `message` 就是业务结论，`cause` 里是原始错误；
 * - 开：`{ name: 'Error', message, stack }` 普通对象 → `message` 仍是同一份结论。
 * 两者都走 `message`，所以这里不需要认识 Mastra 的每一种包装。
 */

/** 错误对象自己一句话都没说时的兜底文案 */
const FALLBACK_ERROR_TEXT = '执行失败（错误对象没有说明原因）'

/** 取出错误自带的说明（`Error` 与非 `Error` 的普通对象取同一处：`message`） */
const messageOf = (error: unknown): string => {
  // `typeof null === 'object'`：空值不配一句 "null"
  if (error === null || error === undefined) return ''
  if (error instanceof Error) return error.message
  if (typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    return typeof message === 'string' ? message : String(error)
  }
  return String(error)
}

/**
 * 错误 → 一行结论文本（`toAISdkStream` 的 `onError`）。
 *
 * 空白消息视为"没说"（有些框架会抛 `new Error('')`），交给兜底文案。
 */
export const toErrorText = (error: unknown): string => {
  const candidate = typeof error === 'string' ? error : messageOf(error)
  const text = candidate.trim()
  return text.length > 0 ? text : FALLBACK_ERROR_TEXT
}
