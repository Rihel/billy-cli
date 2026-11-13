import { CHAT_MESSAGE_MAX_CHARS } from '@repo/shared'

/** 转出来的文件名：`长文本-20261114-001530.md`（本地时间，用户在文件树里能一眼认出来） */
export const longTextFileName = (now: Date = new Date()): string => {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `长文本-${stamp}.md`
}

/**
 * 粘贴超过这个字符数就当附件（约两千字）。
 *
 * 阈值远低于 8000 的硬上限：粘贴多半是日志 / 长文 / 资料，本意是"给你看看"，不是"这是我的问题"。
 * 转成附件后输入框留空，用户还能写自己的问题；短片段（几百字）仍然内联，不当附件。
 */
export const LONG_TEXT_PASTE_MIN_CHARS = 2000

/** 把一段长文本做成待上传的 Markdown 文件（粘贴转附件与超长兜底共用） */
export const createLongTextFile = (text: string, now: Date = new Date()): File =>
  new File([text], longTextFileName(now), { type: 'text/markdown' })

export interface LongTextSplit {
  /** 真正作为 `message` 发出去的文本（超长时是一句说明） */
  content: string
  /** 只有超长时才有：正文全文落成的 Markdown 附件 */
  file?: File
}

/**
 * 消息超过上限时，把全文转成一个 Markdown 附件，正文换成一句说明。
 *
 * 这是**发送时的兜底**：粘贴长文本在粘贴那一刻就转成附件了（`pasteTextAsAttachment`，
 * 阈值 {@link LONG_TEXT_PASTE_MIN_CHARS}），只有"手打 / 多次粘贴累计"超过 8000 时才会走到这里。
 * 仍然比一个 400 好：附件会由服务端**内联成文字**交给模型，效果与直接发消息一致。
 *
 * 返回 `file` 而不是在这里上传：上传、校验、气泡展示都复用现有那条附件链路，
 * 这里只负责"要不要转、正文换成什么"。
 */
export const splitLongText = (
  text: string,
  maxChars: number = CHAT_MESSAGE_MAX_CHARS,
): LongTextSplit => {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return { content: trimmed }
  const file = createLongTextFile(trimmed)
  return {
    content: `内容较长（${trimmed.length} 字），已转为附件「${file.name}」。请阅读附件内容后回答。`,
    file,
  }
}
