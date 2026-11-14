/**
 * 密钥提示（`sk-…abcd`）：给人辨认"配的是哪一把"，不足以还原密钥。
 *
 * 从原 `modules/ai-model/secret-hint.ts` 收到 core（模型配置已归网关与 main，
 * runtime 只在连接器 / 工具设置里展示提示串）。
 */
export const hintOf = (plain: string): string =>
  plain.length >= 8 ? `${plain.slice(0, 3)}…${plain.slice(-4)}` : `…${plain.slice(-2)}`
