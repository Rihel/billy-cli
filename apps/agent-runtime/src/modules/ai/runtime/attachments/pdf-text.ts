import { extractText, getDocumentProxy } from 'unpdf'

/**
 * PDF → 纯文本（**本地提取，不依赖供应商的文件输入能力**）。
 *
 * ## 为什么必须这么做
 *
 * 供应商的"文件输入"能力并不可靠：以 DeepSeek 官方适配器为例，它的 user 分支**只认
 * `mediaType` 以 `image/` 开头的文件**，PDF 会被它记一条 `Unsupported user message part type`
 * 警告后**静默丢掉** —— 运行照样"成功"，用户看到的是模型对着一份看不见的 PDF 胡说
 * （2026-10-07 的"识别不了 PDF"就是这么来的）。
 *
 * 所以 PDF 一律**先把文字抽出来内联进提示词**：这条路对任何模型都有效（包括纯文本模型），
 * 也不依赖供应商是否支持文件通道。抽不出文字（扫描件 / 纯图 PDF）时由调用方决定怎么兜底 ——
 * 本模块只负责"能不能抽出来"这一件事，不编造内容。
 *
 * ## 为什么用 `unpdf` 而不是 pdfjs 原始包
 *
 * `unpdf` 是服务端友好的封装（无 DOM 依赖、纯 ESM、只有解析所需部分），
 * 而 pdfjs 本体在 Node 下要处理 worker / canvas 这些与"取文字"无关的东西，徒增脆弱。
 */

/** 提取结果：文字 + 有多少页（页数进提示词，让模型知道这是否完整） */
export interface PdfTextResult {
  text: string
  pages: number
}

/**
 * 抽 PDF 文本。
 *
 * 返回 `null` 表示**抽不出可用文字**（扫描件、加密、损坏、或确实没有文本层）——
 * 刻意不抛错：调用方要能据此走"当图片喂给视觉模型"或"明确告诉用户读不了"的分支，
 * 而不是让整轮失败。
 */
export const extractPdfText = async (body: Buffer): Promise<PdfTextResult | null> => {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(body))
    const { text, totalPages } = await extractText(pdf, { mergePages: true })
    const merged = (Array.isArray(text) ? text.join('\n') : text).trim()
    if (merged.length === 0) return null
    return { text: merged, pages: totalPages }
  } catch {
    // 加密 / 损坏 / 解析器不吃这份 PDF：交给调用方兜底，不在这里抛
    return null
  }
}
