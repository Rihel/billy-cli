/**
 * 用户消息正文的折叠口径：**最多 10 行**。
 *
 * 为什么按像素量、不用 CSS `line-clamp`：用户消息是纯文本 + `whitespace-pre-wrap`
 * （换行由用户自己打），`-webkit-line-clamp` 对 `pre-wrap` 的换行计数在 Safari 上不稳；
 * 这里用「行高 × 10」算实际像素上限，再用 `scrollHeight` 判断要不要出折叠按钮。
 *
 * 纯函数放这里是为了能在 node 环境直接测（`apps/admin` 的单测不装 jsdom）。
 */

/** 折叠后最多显示几行 */
export const USER_MESSAGE_COLLAPSED_LINES = 10

/** 折叠后的像素高度（行高来自计算样式，随字号 / 主题变化） */
export const collapsedMaxHeightOf = (lineHeightPx: number): number =>
  lineHeightPx * USER_MESSAGE_COLLAPSED_LINES

/**
 * 解析计算样式里的 `line-height`：正常是 px；`normal` 时退回 `font-size × 1.6`
 * （与 Tailwind 默认 `leading-normal` 的比例一致），都拿不到数字时给 24px 兜底，
 * 保证「量不出来」时不会退化成不折叠。
 */
export const resolveLineHeightPx = (lineHeight: string, fontSize: string): number => {
  const parsed = Number.parseFloat(lineHeight)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  const size = Number.parseFloat(fontSize)
  return Number.isFinite(size) && size > 0 ? size * 1.6 : 24
}

/** 内容是否超过折叠上限（+1 吸收亚像素误差：刚好 10 行不该出按钮） */
export const isOverflowing = (contentHeightPx: number, lineHeightPx: number): boolean =>
  contentHeightPx > collapsedMaxHeightOf(lineHeightPx) + 1
