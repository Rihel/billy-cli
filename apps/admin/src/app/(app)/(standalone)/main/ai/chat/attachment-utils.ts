import { CHAT_ATTACHMENT_MAX_BYTES, type ChatAttachmentModel } from '@repo/shared'

/**
 * 对话附件的分类与提示文案（前端唯一一处口径）。
 *
 * 与服务端的判据**刻意保持同一份分类意图**（服务端 `ChatAttachmentService` 有一份对应的实现，
 * 但服务端只信自己的判断，不信前端传来的媒体类型）：前端这份管"收不收、怎么提示"，
 * 服务端那份管"怎么喂给模型"。两边分开写是有意的 —— 前端的拦截是体验，后端的校验是底线。
 */

/** 允许随消息提交的文件类型：图片 + 常见文档（与用户口径一致） */
export const ATTACHMENT_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/markdown,text/csv'

/** 图片类型（能出缩略图的那些；与服务端"按 image part 喂给模型"的集合一致） */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** 文本类后缀（媒体类型常常给不准，靠后缀兜底；与服务端的内联判据同一份） */
const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'log',
  'sql',
  'ini',
  'conf',
  'toml',
  'properties',
  'sh',
  'py',
  'ts',
  'tsx',
  'js',
  'jsx',
])

const extensionOf = (filename: string): string =>
  filename.includes('.') ? (filename.split('.').pop() ?? '').toLowerCase() : ''

/** 是不是图片（决定出缩略图还是文件卡） */
export const isImageAttachment = (filename: string, mediaType: string): boolean =>
  IMAGE_TYPES.has(mediaType.toLowerCase()) ||
  ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extensionOf(filename))

/**
 * 是不是"内容会被内联进提示词"的文本类附件。
 *
 * 界面上要说清这一点：用户得知道这份附件是**内容进去了**（模型真在读）还是**只传了个文件**
 * （模型能不能读取决于供应商）。两类都给，但别让用户猜。
 */
export const isInlineTextAttachment = (filename: string, mediaType: string): boolean =>
  mediaType.toLowerCase().startsWith('text/') || TEXT_EXTENSIONS.has(extensionOf(filename))

/** 人类可读的文件大小（1024 进制，保留一位小数） */
export const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** 单个文件是否超限（≤2MB） */
export const isWithinSizeLimit = (file: File): boolean =>
  file.size > 0 && file.size <= CHAT_ATTACHMENT_MAX_BYTES

/** 文件类型是否在允许清单里（accept 属性只是提示，粘贴进来的文件不走它，必须自己判） */
export const isAcceptableFile = (file: File): boolean => {
  const acceptList = ATTACHMENT_ACCEPT.split(',').map((item) => item.trim())
  if (acceptList.includes(file.type)) return true
  const extension = extensionOf(file.name)
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf'].includes(extension)) return true
  return TEXT_EXTENSIONS.has(extension)
}

/**
 * 单个文件被拒的原因（能收就返回 null）。
 *
 * 为什么自己复判一遍：`PromptInput` 的 `onError` 只给"整批失败"的粗粒度回调，
 * 而我们需要**逐个文件**给出"哪个文件、为什么不行"，这只能自己来。
 */
export const rejectReasonOf = (file: File): string | null => {
  if (!isAcceptableFile(file)) {
    return `「${file.name}」不是支持的格式（只收图片、PDF 与常见文本文件）`
  }
  if (!isWithinSizeLimit(file)) {
    return `「${file.name}」超过 2MB 上限（${formatFileSize(file.size)}）`
  }
  return null
}

/** 把已上传的附件做成请求体里的那一份（与 `AgentChatSchema.attachments` 对齐） */
export const toAttachmentPayload = (
  uploaded: readonly { key: string; file: File }[],
): ChatAttachmentModel[] =>
  uploaded.map(({ key, file }) => ({
    key,
    filename: file.name,
    mediaType: file.type || 'application/octet-stream',
    /**
     * 夹到上限：`AgentChatSchema` 的 `bytes` 是 `.max(CHAT_ATTACHMENT_MAX_BYTES)`，
     * 上面已经按同一个数拒过超限文件，这里的夹取只为兜住极小的边界差
     * （`File.size` 与上传出去的实际字节数理论上一致）。
     */
    bytes: Math.min(file.size, CHAT_ATTACHMENT_MAX_BYTES),
  }))
