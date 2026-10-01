/**
 * 密钥提示（`sk-…abcd`）：给人辨认"配的是哪一把"，不足以还原密钥。
 *
 * 明文入库之后（2026-10-01 决定）本文件只剩这一个纯函数：加解密已删除，
 * 接口用它在**读取时**从明文派生提示串。所以它只依赖字符串，不依赖任何配置。
 */
export const hintOf = (plain: string): string =>
  plain.length >= 8 ? `${plain.slice(0, 3)}…${plain.slice(-4)}` : `…${plain.slice(-2)}`
