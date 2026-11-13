import { Inject, Injectable } from '@nestjs/common'
import dedent from 'dedent'
import { AppLogger, ObjectStorage } from '@repo/kits'
import {
  attachmentCapabilityIssue,
  CHAT_ATTACHMENT_TEXT_INLINE_LIMIT,
  looksLikeImage,
  looksLikePdf,
  modalitySupport,
  type ChatAttachmentModel,
} from '@repo/shared'
import type { ModelMessage, UserContent } from 'ai'
import {
  ChatAttachmentFailedError,
  ModelCapabilityMismatchError,
  UserContentNotAppendableError,
} from '../core/errors.js'
import { AttachmentKeyPolicy } from './attachment-key.js'
import { extractPdfText } from './pdf-text.js'

/**
 * 一轮问答里的附件：把「对象存储里的 key」变成「模型能消费的消息内容」。
 *
 * ## 为什么只传 key、不在请求体里带文件
 *
 * 服务端请求体上限 2mb（`main.ts`），而附件本身的上限也是 2mb —— 一旦把文件内联进请求体，
 * 光是 base64 膨胀（+33%）就必然超限。所以链路定成：
 *
 * ```
 * 前端 --预签名直传--> 对象存储 --只回 key--> 随消息提交 --服务端按 key 取回--> 转成模型内容
 * ```
 *
 * 于是请求体的大小与文件大小无关，时间线落库也只存这份元数据（回看历史时再解析可访问地址）。
 *
 * ## 三类附件、三种喂法
 *
 * | 类型 | 怎么给模型 | 为什么 |
 * | --- | --- | --- |
 * | 图片（png/jpeg/webp/gif） | `image` part，内容用 **data URL** | 不依赖"供应商能不能访问我们的存储" —— 预签名地址对内网对象存储不可达，且会过期 |
 * | 文本类（txt/md/csv 等） | 取回后**内联成文本** part，带文件名标注 | 模型看的是文字，没必要走文件通道；超长截断并明确告知 |
 * | PDF（先抽文字） | 先本地抽出文字、内联成文本 part；抽不出（扫描件 / 加密）才退回 `file` part（data URL） | 文本型 PDF 不依赖供应商的文件输入能力；退回时供应商不支持会由上游报错 |
 *
 * 读不回来的附件（对象不存在 / 存储不可用）**直接抛错终止这一轮**：静默丢掉用户发的东西，
 * 等于让模型对着一份看不见的附件胡说，比报错更坏。
 */
@Injectable()
export class ChatAttachmentService {
  /**
   * 文本类附件内联的上限（字符数）。
   *
   * 2MB 的纯文本约 200 万字符，全量塞进上下文会直接顶爆窗口并触发压缩 ——
   * 一份附件吃掉整轮预算不划算。截断是**明示**的（消息里写清截了多少），不悄悄丢。
   */
  private static readonly TEXT_INLINE_LIMIT = CHAT_ATTACHMENT_TEXT_INLINE_LIMIT

  /** 直接当图片喂给模型的媒体类型（其余图片类型也按文件通道走） */
  private static readonly IMAGE_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
  ])

  /** 取回后内联成文字的媒体类型；前缀命中（如 `text/`）或在此列出的都算 */
  private static readonly TEXT_TYPES = new Set([
    'application/json',
    'application/xml',
    'application/x-yaml',
    'application/yaml',
    'application/javascript',
    'application/typescript',
    'application/sql',
  ])

  /** 能按文本读的文件后缀（媒体类型常常是 `application/octet-stream`，靠后缀兜底） */
  private static readonly TEXT_EXTENSIONS = new Set([
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
    'java',
    'go',
    'rs',
    'rb',
    'php',
    'c',
    'h',
    'cpp',
    'css',
    'scss',
  ])

  constructor(
    @Inject(ObjectStorage) private readonly storage: ObjectStorage,
    @Inject(AttachmentKeyPolicy) private readonly keyPolicy: AttachmentKeyPolicy,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /**
   * 取回附件内容，组装成这一轮的**用户消息内容**（文本 + 附件 part 的数组）。
   *
   * 没有附件时返回 `null`，调用方继续用原来的纯字符串路径 —— 这条快路不能因为新功能变慢。
   */
  async buildUserContent(
    text: string,
    attachments: readonly ChatAttachmentModel[] | undefined,
    inputModalities?: readonly string[] | null,
  ): Promise<UserContent | null> {
    if (!attachments || attachments.length === 0) {
      return null
    }
    /**
     * **归属校验必须在读对象之前**：key 是客户端给的，不校验就是一条越权读取
     * （前台用户伪造 `user/<别人 id>/x.png` 就能把别人的文件读出来喂给模型）。
     */
    this.keyPolicy.assertOwned(attachments.map((attachment) => attachment.key))
    this.assertSupported(inputModalities, attachments)

    const parts: Exclude<UserContent, string> = []
    if (text.length > 0) {
      parts.push({ type: 'text', text })
    }

    for (const attachment of attachments) {
      const content = await this.readAttachment(attachment, inputModalities)
      if (content.kind === 'image') {
        parts.push({
          type: 'image',
          image: content.dataUrl,
          mediaType: content.mediaType,
        })
        continue
      }
      if (content.kind === 'file') {
        parts.push({
          type: 'file',
          data: content.dataUrl,
          filename: attachment.filename,
          mediaType: content.mediaType,
        })
        continue
      }
      parts.push({ type: 'text', text: content.text })
    }

    return parts
  }

  /**
   * **权威能力校验**：不支持的附件当场拒绝，绝不交给上游去"静默忽略"。
   *
   * 判据与前端预检**同一份**（`@repo/shared` 的 `attachmentCapabilityIssue`）：
   * 前端可以绕过（改请求体就行），所以服务端必须自己再判一次；而两套判据一定会漂移，
   * 所以共用同一个函数。
   */
  private assertSupported(
    inputModalities: readonly string[] | null | undefined,
    attachments: readonly ChatAttachmentModel[],
  ): void {
    const issue = attachmentCapabilityIssue(inputModalities, attachments)
    if (!issue) return
    if (issue.code === 'undeclared') {
      // 未声明**不拦**：国内厂商普遍不给模态信息，硬拦会把真正的视觉模型也误伤。
      // 留一条 warn 便于排障（"为什么用户发图后模型说看不到"）。
      this.logger.warn('ai.attachment.modality_undeclared', {
        filename: issue.filename,
        key: attachments[0]?.key,
      })
      return
    }
    this.logger.warn('ai.attachment.capability_mismatch', {
      code: issue.code,
      filename: issue.filename,
      inputModalities,
    })
    throw new ModelCapabilityMismatchError(
      issue.filename,
      issue.code === 'vision' ? '当前模型不支持图片输入' : '当前模型不支持文件输入（PDF 等）',
    )
  }

  /**
   * 一条附件 → 一种可消费的内容。
   *
   * 分类只看**我们自己的判据**（媒体类型 + 文件名后缀），不看前端怎么说 ——
   * 前端传来的 `mediaType` 是"用户设备认为的类型"，不可当作可信输入。
   */
  private async readAttachment(
    attachment: ChatAttachmentModel,
    inputModalities: readonly string[] | null | undefined,
  ): Promise<
    | { kind: 'image'; dataUrl: string; mediaType: string }
    | { kind: 'file'; dataUrl: string; mediaType: string }
    | { kind: 'text'; text: string }
  > {
    const mediaType = this.normalizeMediaType(attachment)
    const body = await this.readObject(attachment)

    if (ChatAttachmentService.IMAGE_TYPES.has(mediaType)) {
      return {
        kind: 'image',
        dataUrl: `data:${mediaType};base64,${body.toString('base64')}`,
        mediaType,
      }
    }

    // 已知的文本类：直接内联（最省事、也最不依赖供应商）
    if (this.isTextLike(mediaType, attachment.filename)) {
      return { kind: 'text', text: this.toTextBlock(attachment, body) }
    }

    // 图片只可能落到这里（归一化猜不出后缀的那些）：只有"看着像图片"才值得按图片试
    if (looksLikeImage(attachment)) {
      return {
        kind: 'image',
        dataUrl: `data:${mediaType};base64,${body.toString('base64')}`,
        mediaType,
      }
    }

    /**
     * PDF：**先本地抽文字内联**，抽不出再退回文件通道。
     *
     * ⚠️ 这条必须在"当文本试"**之前**：PDF 字节里也有一大段可读 ASCII
     * （`%PDF-1.4`、对象字典、xref…），先试文本会把整份 PDF 当乱码内联 ——
     * 既没用，又白烧一窗口 token（踩过）。
     *
     * ⚠️ 也**不能只依赖文件通道**：供应商的"文件输入"并不可靠 —— DeepSeek 官方适配器的
     * user 分支只认 `image/*` 的文件，PDF 会被它记一条警告后**静默丢掉**，运行照样成功
     * （2026-10-07"识别不了 PDF"的实际原因）。抽出的文字对任何模型都有效。
     */
    if (looksLikePdf(attachment)) {
      const pdf = await extractPdfText(body)
      if (pdf) {
        return {
          kind: 'text',
          text: this.toTextBlock(attachment, Buffer.from(pdf.text, 'utf8'), {
            kindLabel: 'PDF 文档',
            extra: `共 ${pdf.pages} 页`,
          }),
        }
      }
      /**
       * 抽不出文字（扫描件 / 纯图 PDF / 加密）→ 退回文件通道：模型若支持文件输入还能读；
       * 不支持时由能力校验（`assertSupported`）在上游之前拦下并说清原因，
       * 而不是像过去那样发出去被静默丢掉。
       */
      this.logger.warn('ai.attachment.pdf_no_text_layer', {
        filename: attachment.filename,
        bytes: attachment.bytes,
      })
      /**
       * 退回文件通道**只有这一步**真正需要模型的"文件输入"能力（文本型 PDF 走的是内联文本）。
       * 明确声明不支持就当场拦下说清；未声明（`null`）仍放行 —— 与图片同一姿态，
       * 国内厂商普遍不声明模态，硬拦会误伤。
       */
      if (modalitySupport(inputModalities, 'file') === false) {
        throw new ModelCapabilityMismatchError(
          attachment.filename,
          '这份 PDF 没有文字层（扫描件），当前模型又不支持文件输入',
        )
      }
      return {
        kind: 'file',
        dataUrl: `data:${mediaType};base64,${body.toString('base64')}`,
        mediaType,
      }
    }

    // 剩下的是"认不出类型"的：**先当文本试**（读得出来就内联 —— 对任何模型都能用）
    if (looksLikeTextContent(body)) {
      return { kind: 'text', text: this.toTextBlock(attachment, body) }
    }

    /**
     * 到这里既不是文本、也不是图片、也不是 PDF：明确拒绝 ——
     * 把一段二进制塞给模型换来的只会是幻觉（能力校验那一步已经拦下"模型收不了 PDF"的情况）。
     */
    throw new ModelCapabilityMismatchError(
      attachment.filename,
      '这个附件既不是文本也不是图片，当前模型读不了',
    )
  }

  /** 从对象存储取回原始字节；失败一律转成业务错误（附上文件名，方便用户对号） */
  private async readObject(attachment: ChatAttachmentModel): Promise<Buffer> {
    try {
      const object = await this.storage.getObject({ key: attachment.key })
      return object.body
    } catch (cause) {
      this.logger.error('ai.attachment.read_failed', {
        key: attachment.key,
        filename: attachment.filename,
        cause: cause instanceof Error ? cause.message : String(cause),
      })
      throw new ChatAttachmentFailedError(attachment.filename)
    }
  }

  /**
   * 文本类附件 → 带来源标注的一段文字（截断是明示的）。
   *
   * `options.kindLabel` / `options.extra` 供 PDF 这类"内容是抽出来的"场景补充说明
   * （写清"这是 PDF、共 N 页"，模型才能判断自己拿到的是不是完整内容）。
   */
  private toTextBlock(
    attachment: ChatAttachmentModel,
    body: Buffer,
    options?: { kindLabel?: string; extra?: string },
  ): string {
    const decoded = body.toString('utf8')
    const limit = ChatAttachmentService.TEXT_INLINE_LIMIT
    const truncated = decoded.length > limit
    const content = truncated ? decoded.slice(0, limit) : decoded
    const name = this.escapeName(attachment.filename)
    const kindLabel = options?.kindLabel ?? '附件'
    const details = [
      `整份文件 ${attachment.bytes} 字节`,
      ...(options?.extra ? [options.extra] : []),
    ].join('，')

    return dedent`
      以下是用户上传的 ${kindLabel}《${name}》的内容（${details}）：
      ${content}
      ${truncated ? `\n（内容过长，以上只截取了前 ${limit} 个字符，需要其余部分请让用户分段提供）` : ''}
    `
  }

  /**
   * 归一化媒体类型：
   * - 前端给的可能是空 / `application/octet-stream`，此时**按后缀猜**（浏览器对 `.md` 常给 octet-stream）；
   * - 图片用带 `image/` 前缀的按图片算，其余图片类型（如 `image/tiff`）落到文件通道。
   */
  private normalizeMediaType(attachment: ChatAttachmentModel): string {
    const raw = attachment.mediaType?.trim().toLowerCase() ?? ''
    if (raw && raw !== 'application/octet-stream') {
      return raw
    }
    return this.guessFromFilename(attachment.filename)
  }

  private guessFromFilename(filename: string): string {
    const extension = filename.split('.').pop()?.toLowerCase() ?? ''
    switch (extension) {
      case 'png':
        return 'image/png'
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg'
      case 'webp':
        return 'image/webp'
      case 'gif':
        return 'image/gif'
      case 'pdf':
        return 'application/pdf'
      case 'csv':
        return 'text/csv'
      case 'json':
        return 'application/json'
      case 'md':
      case 'markdown':
        return 'text/markdown'
      default:
        return ChatAttachmentService.TEXT_EXTENSIONS.has(extension)
          ? 'text/plain'
          : 'application/octet-stream'
    }
  }

  private isTextLike(mediaType: string, filename: string): boolean {
    if (mediaType.startsWith('text/')) {
      return true
    }
    if (ChatAttachmentService.TEXT_TYPES.has(mediaType)) {
      return true
    }
    const extension = filename.split('.').pop()?.toLowerCase() ?? ''
    return ChatAttachmentService.TEXT_EXTENSIONS.has(extension)
  }

  /**
   * 文件名要放进**给模型的文字**里，做最小净化：去掉换行（会打乱段落结构）与反引号
   * （会破坏 Markdown 代码块边界）。
   */
  private escapeName(filename: string): string {
    return filename
      .replace(/[\r\n]+/g, ' ')
      .replaceAll('`', "'")
      .slice(0, 255)
  }
}

/**
 * 把"当前用户消息"替换成多模态内容的那一条。
 *
 * 上下文组装是**先给纯文本、再追加当前输入**（见 `ContextService.buildInput`），
 * 所以附件注入发生在最后一条消息上，历史部分完全不受影响。
 *
 * 最后一条不是 user 消息时**抛错而不是静默返回**：那意味着附件会被悄悄丢掉 ——
 * 用户以为发出去了、模型却看不见，只会得到一段对看不见的附件胡说的回复，
 * 比当场报错坏得多（这类隐式依赖要靠断言钉住，不能靠"今天正好成立"）。
 */
export const withUserContent = (messages: ModelMessage[], content: UserContent): ModelMessage[] => {
  const last = messages.at(-1)
  if (!last || last.role !== 'user') {
    throw new UserContentNotAppendableError(messages.length)
  }
  return [...messages.slice(0, -1), { ...last, content }]
}

/**
 * 这份字节能不能当文本读（判据：没有 NUL 字节、且能按 UTF-8 解出可打印内容）。
 *
 * 为什么要试：供应商给的媒体类型经常是 `application/octet-stream`，后缀也可能是 `.log` / `.dat`
 * 这类我们没收录的 —— 而它们十有八九就是文本。能内联成文字，任何模型都读得到，
 * 比"当作二进制塞给模型"或"直接拒绝"都好。
 */
export const looksLikeTextContent = (body: Buffer): boolean => {
  if (body.length === 0) return false
  if (body.includes(0)) return false
  const decoded = body.toString('utf8')
  if (decoded.includes('\uFFFD')) return false
  let printable = 0
  for (const char of decoded) {
    const code = char.codePointAt(0) ?? 0
    if (code === 9 || code === 10 || code === 13 || code >= 0x20) printable += 1
  }
  return printable / decoded.length >= 0.9
}
