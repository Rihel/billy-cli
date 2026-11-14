/**
 * 密钥提示（`sk-…abcd`）：给人辨认"配的是哪一把"，不足以还原密钥。
 *
 * 与 `modules/ai-model/secret-hint.ts` 同口径（**明文入库**是 2026-10-01 的工程取舍，
 * 接口只回派生提示串）。这里复制一份纯函数，避免控制面模块反向依赖旧的 ai 目录。
 */
export const hintOf = (plain: string): string =>
  plain.length >= 8 ? `${plain.slice(0, 3)}…${plain.slice(-4)}` : `…${plain.slice(-2)}`
