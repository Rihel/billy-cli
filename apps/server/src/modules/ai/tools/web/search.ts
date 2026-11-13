import { z } from 'zod'
import { ToolDeniedError } from '../../core/tools/tools.types.js'
import { fetchGuarded } from './http.js'

/**
 * **DeepSeek 搜索接口的客户端**（`POST /v1/tools/search`，见 api-docs.deepseek.com/zh-cn/guides/search）。
 *
 * 为什么单独一层、而不是写在工具方法里：
 * - 请求体字段名（`need_content` / `ori_question`）和响应字段名（`rerank_score` / `authority`）
 *   是**外部协议**，与我们的领域词汇无关 —— 映射只在这里做一次；
 * - 错误码到工具结论的翻译（401 / 402 / 429 / 5xx）也在这里收口，工具方法只关心"搜到了什么"；
 * - 出网仍走 `http.ts` 的唯一出口：同一份超时 / 字节上限 / 内网闸 / 取消语义，不另开一条网络路径。
 *
 * 计费口径（文档明确）：**按成功请求次数**计费，与 `count` 无关；空结果、失败、超时不计费。
 * 所以工具侧不该为了省钱把一次搜索拆成多次，也不该把 `count` 当成"省钱旋钮"。
 */

/** 一次搜索最多读多少字节（返回的是摘要 JSON；超了通常是 `needContent` 打开且条数太多） */
const MAX_RESPONSE_BYTES = 1024 * 1024

/**
 * 接口返回的一条结果。
 *
 * 字段**全部可选**解析：对方加字段、或某条缺 `title`，都不该让整次搜索失败 ——
 * 工具出参再补成稳定的形状（缺失给空串 / `null`）。
 */
const SearchItemSchema = z.object({
  rerank_score: z.number().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  snippet: z.string().optional(),
  summary: z.string().optional(),
  content: z.string().optional(),
  site_name: z.string().nullish(),
  date: z.string().nullish(),
  authority: z.number().optional(),
})

const SearchResponseSchema = z.object({
  results: z.array(SearchItemSchema).default([]),
})

/** 错误响应（OpenAI 兼容格式；`param` 恒为 null，这里不关心） */
const ApiErrorSchema = z.object({
  error: z.object({ message: z.string().optional() }).optional(),
})

/** 搜索接口的一条结果（已换成我们的字段名；数值都给默认值） */
export interface SearchItem {
  title: string
  url: string
  snippet: string
  /** 长摘要（文档口径 600~800 字符，适合给模型读） */
  summary: string
  /** 网页正文（只有 `needContent` 为 true 时才有；可能为空串） */
  content: string
  siteName: string | null
  /** 发布时间（UTC ISO）；未知为 null */
  date: string | null
  /** 相关度综合分 0~3（≥1.5 为优质） */
  rerankScore: number
  /** 权威性 0~4（≥3 极权威；-1 未知） */
  authority: number
}

export interface SearchWebOptions {
  /** 服务地址（只到域名 / 端口；路径由本文件拼） */
  baseUrl: string
  apiKey: string
  query: string
  count: number
  needContent: boolean
  /** 用户的原始问题（可选，帮助理解搜索意图） */
  question?: string
  timeoutMs: number
  allowPrivateNetwork: boolean
  signal?: AbortSignal
}

export interface SearchWebResult {
  items: SearchItem[]
}

/** 接口地址：`baseUrl` 只到域名，路径固定拼在后面（与 DeepSeek 文档一致） */
const searchEndpoint = (baseUrl: string): string => `${baseUrl.replace(/\/+$/, '')}/v1/tools/search`

/** 一次搜索：发请求 → 按状态码翻结论 → 解析成稳定形状 */
export const searchWeb = async (options: SearchWebOptions): Promise<SearchWebResult> => {
  const request = {
    query: options.query,
    count: options.count,
    need_content: options.needContent,
    ...(options.question ? { ori_question: options.question } : {}),
  }

  let response
  try {
    response = await fetchGuarded(searchEndpoint(options.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(request),
      timeoutMs: options.timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
      allowPrivateNetwork: options.allowPrivateNetwork,
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (error) {
    throw toSearchError(error, options)
  }

  // 非 200 一律是**接口层错误**（与 web-request 的"非 2xx 也把正文给模型"不同：
  // 搜索没有"错误页正文"这回事，401 / 402 / 429 各自的下一步动作完全不同）
  if (response.status !== 200) {
    throw httpError(response.status, apiMessage(response.text))
  }
  if (response.truncated) {
    throw new ToolDeniedError(
      'internal',
      '搜索响应超过读取上限，正文不完整',
      '把 count 调小，或关掉 needContent 再搜',
    )
  }

  let payload: z.infer<typeof SearchResponseSchema>
  try {
    payload = SearchResponseSchema.parse(JSON.parse(response.text))
  } catch {
    throw new ToolDeniedError(
      'internal',
      `搜索接口返回的不是预期 JSON（HTTP ${response.status}）`,
      '稍后重试；持续失败就检查工具配置里的 baseUrl 是不是 DeepSeek 接口地址',
    )
  }

  return { items: payload.results.map(toItem) }
}

/** 外部字段 → 我们的字段（缺什么补什么，不把 undefined 漏给出参） */
const toItem = (raw: z.infer<typeof SearchItemSchema>): SearchItem => ({
  title: raw.title ?? '',
  url: raw.url ?? '',
  snippet: raw.snippet ?? '',
  summary: raw.summary ?? '',
  content: raw.content ?? '',
  siteName: raw.site_name ?? null,
  date: raw.date ?? null,
  rerankScore: raw.rerank_score ?? 0,
  authority: raw.authority ?? -1,
})

/** 错误体里的原话（有就给模型看，没有就空串） */
const apiMessage = (text: string): string => {
  try {
    const parsed = ApiErrorSchema.parse(JSON.parse(text))
    return parsed.error?.message?.trim() ?? ''
  } catch {
    return ''
  }
}

/**
 * 状态码 → 工具结论。
 *
 * 每一档的"下一步"都不同，所以不能合成一句"搜索失败"：
 * 401 是密钥问题（模型改 query 没用）、402 是没钱、429 是并发太高（可重试）、
 * 5xx / 408 / 504 是对方的问题（可重试），其余 4xx 不改请求就别重试（文档口径）。
 */
const httpError = (status: number, message: string): ToolDeniedError => {
  const detail = message ? `：${message}` : ''
  if (status === 400) {
    return new ToolDeniedError(
      'invalid-input',
      `搜索请求被拒（400）${detail}`,
      '检查搜索词：不能全为空白，长度 1~128 字符',
    )
  }
  if (status === 401) {
    return new ToolDeniedError(
      'precheck-failed',
      `搜索密钥无效（401）${detail}`,
      '后台 → AI 工具 → web-search 更新 DeepSeek API Key；或改用 DeepSeek 官方模型（会自动复用模型密钥）',
    )
  }
  if (status === 402) {
    return new ToolDeniedError(
      'precheck-failed',
      `DeepSeek 账号余额不足（402）${detail}`,
      '充值后再搜；这是账号问题，不是"没有结果"',
    )
  }
  if (status === 403) {
    return new ToolDeniedError(
      'forbidden',
      `搜索被拒绝（403）${detail}`,
      '账号或来源被限制：换一把密钥，或稍后再试',
    )
  }
  if (status === 408) {
    return new ToolDeniedError('timeout', `搜索请求超时（408）${detail}`, '稍后重试', true)
  }
  if (status === 413) {
    return new ToolDeniedError('invalid-input', `搜索请求体过大（413）${detail}`, '把 count 调小')
  }
  if (status === 429) {
    return new ToolDeniedError(
      'rate-limited',
      `搜索被限流（429）${detail}`,
      '账号级上限 100 QPS：等几秒再搜，不要并发猛搜',
      true,
    )
  }
  if (status === 504) {
    return new ToolDeniedError('timeout', `搜索上游超时（504）${detail}`, '稍后重试', true)
  }
  if (status >= 500) {
    return new ToolDeniedError('internal', `搜索服务错误（${status}）${detail}`, '稍后重试', true)
  }
  return new ToolDeniedError('internal', `搜索失败（HTTP ${status}）${detail}`, '稍后重试')
}

/**
 * 出网层抛的 `ToolDeniedError` 再翻一次：
 *
 * `http.ts` 把"连不上 / 超时"统一归成 `invalid-input`（对任意 URL 抓取而言够用），
 * 但对搜索来说，超时是**可重试的环境问题**、DNS 失败是**部署侧问题**，
 * 让模型去"改入参"是错的结论。
 */
const toSearchError = (error: unknown, options: SearchWebOptions): unknown => {
  if (options.signal?.aborted) {
    return new ToolDeniedError('aborted', '这次搜索已被取消', undefined, false)
  }
  if (error instanceof ToolDeniedError) {
    if (/超时/.test(error.message)) {
      return new ToolDeniedError(
        'timeout',
        error.message,
        '稍后重试；持续超时就调大工具配置里的 timeoutMs',
        true,
      )
    }
    return new ToolDeniedError(
      'internal',
      error.message,
      '检查服务端网络与工具配置里的 baseUrl；稍后重试',
      true,
    )
  }
  return error
}
