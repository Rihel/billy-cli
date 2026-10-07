import { modalitySupport } from './ai-modality.dict'

/**
 * **附件是否超出模型能收的范围**（前后端共用一份判据）。
 *
 * ## 为什么需要它
 *
 * 模型不一定支持图片输入：给一个纯文本模型发图，表现取决于上游（报错、或者**静默忽略**）——
 * 后者最坏：用户以为模型看过了图，其实它什么也没看到，还会基于幻觉回答。
 * 所以"这个模型能不能收图 / 收文件"必须是一份**显式、可查**的事实，而不是碰运气。
 *
 * ## 能力从哪来
 *
 * **模型实体上的 `input_modalities` 字段**（`ai_models.input_modalities`，取值见 `AiModality`）。
 * 不再是塞在 `capabilities` jsonb 里的约定键 —— 那里是"供应商给什么存什么"，
 * 同步会整列覆盖，语义上也不该承载我们的模型画像。
 *
 * ## 三态，不是两态
 *
 * `inputModalities` 为 `null`（未声明）时**一律不拦**：国内厂商的"列模型"接口普遍不给模态信息，
 * 硬按"不支持"处理会把真正的视觉模型也误伤（用户粘了图却被告知不支持，而其实模型能看）。
 * 明确声明了才判：`["text"]` → 图片 / 文件要拦下并说清；含 `image` / `file` → 放行。
 */

/** 一个附件的"看起来是什么"（只看文件名后缀与媒体类型，不看内容） */
export interface AttachmentTypeHint {
  filename: string
  mediaType: string
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'])

const extensionOf = (filename: string): string =>
  filename.includes('.') ? (filename.split('.').pop() ?? '').toLowerCase() : ''

/** 看着像图片（媒体类型或后缀命中） */
export const looksLikeImage = (hint: AttachmentTypeHint): boolean =>
  hint.mediaType.toLowerCase().startsWith('image/') || IMAGE_EXTENSIONS.has(extensionOf(hint.filename))

/**
 * 看着像 PDF。
 *
 * PDF 归在"文件"这一类：模型不支持文件输入时我们**没有可靠的降级路径**
 * （2MB 的 PDF 抽不出可用的文本就得整轮失败），所以直接拒绝比让上游报错清楚。
 */
export const looksLikePdf = (hint: AttachmentTypeHint): boolean =>
  hint.mediaType.toLowerCase() === 'application/pdf' || extensionOf(hint.filename) === 'pdf'

/**
 * 这批附件是否超出这个模型能收的范围。
 *
 * 返回三态，因为"未声明"与"明确不支持"必须分开处理：
 * - `{ code: 'undeclared', ... }`：模型**没声明**模态 —— **不拦**，只在界面上提示
 *   （国内厂商普遍不给，硬拦会把真正的视觉模型误伤）；
 * - `{ code: 'vision', ... }`：明确声明收不了图片 → 拦下并说清是哪个文件；
 * - `null`：没问题。
 *
 * **前后端共用这一份判据**：前端拿它提前拦，服务端拿它做权威校验（前端可以绕过，判据不能有两套）。
 *
 * **只判图片**：其余类型我们都能自己读出来内联成文字（文本直接读、**PDF 本地抽文字层**、
 * 未知类型先当文本试），完全不依赖模型的输入能力 —— 那类附件给任何模型都不会"静默丢掉"。
 * PDF 因此**不再要求 `file` 能力**：它只在"抽不出文字层（扫描件）退回文件通道"那一步才需要，
 * 而那一步在服务端读文件时才知道（见 `ChatAttachmentService.readAttachment`）。
 */
export const attachmentCapabilityIssue = (
  inputModalities: readonly string[] | null | undefined,
  attachments: readonly AttachmentTypeHint[],
): { code: 'vision' | 'undeclared'; filename: string } | null => {
  for (const attachment of attachments) {
    // 只判图片：PDF 与文本类我们都能自己转成文字，不需要模型有对应能力
    if (!looksLikeImage(attachment)) continue

    const support = modalitySupport(inputModalities, 'image')
    if (support === false) return { code: 'vision', filename: attachment.filename }
    if (support === null) return { code: 'undeclared', filename: attachment.filename }
  }
  return null
}
