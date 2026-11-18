import { Inject, Injectable } from '@nestjs/common'
import { z } from 'zod'
import { AppLogger } from '@repo/kits'
import { CapabilityDecl, CapabilityGroup, findCapabilityDecl } from '@repo/capability'
import {
  BROWSER_UA,
  WebCache,
  WebToolError,
  browserHeaders,
  detectAntiBot,
  extractTitle,
  fetchGuarded,
  footerOf,
  htmlToMarkdown,
  htmlToPlainText,
  looksLikeHtml,
  makeRef,
  pageOf,
  splitPages,
  type CachedDoc,
  type PageView,
  type WebResponse,
} from '@repo/web-runtime'
import type { ToolInvokeRequest, ToolOutcome } from '@repo/contracts'
import { ToolWorkerConfig, type ToolWorkerConfigValue } from '../../config/app-config.js'

/** 声明里那份 zod 解析出来的形状（机制包宽类型丢了推导，这里补一处结构断言） */
interface WebRequestInput {
  url?: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'
  query?: Record<string, string | number | boolean>
  headers?: Record<string, string>
  body?: string | Record<string, unknown> | unknown[]
  ref?: string
  page: number
}

interface WebPageOutput {
  ref: string
  url: string
  finalUrl: string
  status: number
  contentType: string
  title: string | null
  cached: boolean
  truncated: boolean
  document: {
    chars: number
    bytes: number
    lines: number
    pages: number
    pageLines: number
    fetchedAt: string
  }
  page: { current: number; total: number; remaining: number; isLast: boolean }
  content: string
  footer: string
  headers?: Record<string, string>
  next?: string
  notice?: string
}

const normalizeUrl = (raw: string): URL => {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new WebToolError(`不是合法的 URL：${raw}`, '要带协议与主机名，例如 https://example.com/a')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebToolError(`只支持 http / https，收到的是 ${url.protocol}`, '换成网页或 API 的地址')
  }
  return url
}

const toReadableText = (
  response: WebResponse,
  logger: AppLogger,
): { text: string; title: string | null; note?: string } => {
  if (!looksLikeHtml(response.contentType, response.text)) {
    return { text: response.text.replace(/\r\n?/g, '\n'), title: null }
  }
  const title = extractTitle(response.text)
  const blocked = detectAntiBot({ status: response.status, title, html: response.text })
  if (blocked) {
    return {
      text: '',
      title,
      note: `这个站点有反爬 / 人机验证（${blocked}），静态抓取拿不到正文 —— 换一个来源`,
    }
  }
  let text = ''
  try {
    text = htmlToMarkdown(response.text)
  } catch (error) {
    logger.warn('tool_worker.web_markdown_failed', { url: response.finalUrl, error: String(error) })
  }
  if (!text.trim()) text = htmlToPlainText(response.text)
  if (!text.trim()) {
    return { text: '', title, note: '页面没有可读正文（多半是纯 JS 渲染），换一个来源或 API' }
  }
  return { text, title }
}

const prettyJson = (text: string): string => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text.replace(/\r\n?/g, '\n')
  }
}

const buildDoc = (input: {
  ref: string
  url: string
  response: WebResponse
  text: string
  pageLines: number
  title: string | null
  extra: Record<string, unknown>
}): CachedDoc => {
  const { lines, bounds } = splitPages(input.text, input.pageLines)
  return {
    ref: input.ref,
    url: input.url,
    finalUrl: input.response.finalUrl,
    status: input.response.status,
    contentType: input.response.contentType,
    title: input.title,
    text: input.text,
    chars: input.text.length,
    bytes: input.response.bytes,
    lines,
    pages: bounds.length,
    pageLines: input.pageLines,
    bounds,
    truncated: input.response.truncated,
    fetchedAt: Date.now(),
    extra: input.extra,
  }
}

const present = (
  doc: CachedDoc,
  page: number,
  cached: boolean,
  toolKey: string,
  extra: { note?: string } = {},
): WebPageOutput => {
  const view: PageView = pageOf(doc, page)
  const footer = footerOf(view, doc.pageLines)
  const content = view.content ? `${view.content}\n\n---\n\n${footer}` : footer
  const notices: string[] = []
  if (view.notice) notices.push(view.notice)
  if (doc.truncated) notices.push('内容超过读取上限，后面还有但没抓回来')
  if (extra.note) notices.push(extra.note)
  const next = view.isLast
    ? undefined
    : `还有 ${view.remaining} 页：再调一次 ${toolKey}，传 ref="${doc.ref}"、page=${view.page + 1}`
  const headers = doc.extra.headers as Record<string, string> | undefined
  return {
    ref: doc.ref,
    url: doc.url,
    finalUrl: doc.finalUrl,
    status: doc.status,
    contentType: doc.contentType,
    title: doc.title,
    cached,
    truncated: doc.truncated,
    document: {
      chars: doc.chars,
      bytes: doc.bytes,
      lines: doc.lines,
      pages: doc.pages,
      pageLines: doc.pageLines,
      fetchedAt: new Date(doc.fetchedAt).toISOString(),
    },
    page: {
      current: view.page,
      total: view.pages,
      remaining: view.remaining,
      isLast: view.isLast,
    },
    content,
    footer,
    ...(headers ? { headers } : {}),
    ...(next ? { next } : {}),
    ...(notices.length ? { notice: notices.join('；') } : {}),
  }
}

/** web-request 执行器：任意方法 / 头 / body，响应按类型给可读文本；缓存与 web-fetch 同形 */
@Injectable()
@CapabilityGroup({ risk: 'read' })
export class WebRequestExecutor {
  private readonly cache = new WebCache()

  constructor(
    @Inject(ToolWorkerConfig) private readonly config: ToolWorkerConfigValue,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  @CapabilityDecl({
    tool: 'web-request',
    title: '请求 HTTP 接口',
    description: '直接发一个 HTTP 请求，用于 JSON 接口、需要 POST 或自定义头的场景。',
    risk: 'write',
    input: z.object({
      url: z.string().min(1).max(2048).optional().describe('请求地址；首次请求必填'),
      method: z
        .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
        .default('GET')
        .describe('HTTP 方法'),
      query: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe('查询参数'),
      headers: z.record(z.string(), z.string()).optional().describe('自定义请求头'),
      body: z
        .union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
        .optional()
        .describe('请求体'),
      ref: z.string().min(1).max(64).optional().describe('上一次请求返回的缓存句柄'),
      page: z.number().int().positive().default(1).describe('要第几页'),
    }),
  })
  async webRequest(request: ToolInvokeRequest): Promise<ToolOutcome> {
    // 与登记同一份入参
    const parsed = findCapabilityDecl(this, 'web-request').input.safeParse(request.input)
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: `web-request 参数不合法：${parsed.error.issues[0]?.message ?? '未知错误'}`,
        retryable: false,
      }
    }
    const input = parsed.data as WebRequestInput
    const web = this.config.web
    const config = {
      timeoutMs: web.timeoutMs,
      maxBytes: web.maxBytes,
      pageLines: web.pageLines,
      cacheTtlMs: web.cacheTtlMs,
      allowPrivateNetwork: web.allowPrivateNetwork,
      userAgent: web.userAgent ?? BROWSER_UA,
    }

    try {
      if (input.ref) {
        const cached = this.cache.get(input.ref, config.cacheTtlMs)
        if (cached) return { ok: true, data: present(cached, input.page, true, 'web-request') }
        if (!input.url) {
          return {
            ok: false,
            reason: 'invalid-input',
            message: `缓存里已经没有 ${input.ref} 了（过期或换到了别的 worker）`,
            hint: '重新传 url / method / body 再请求一次',
            retryable: false,
          }
        }
      }
      if (!input.url) {
        return {
          ok: false,
          reason: 'invalid-input',
          message: '既没有 url 也没有 ref',
          hint: '首次请求要传 url',
          retryable: false,
        }
      }

      const method = (input.method ?? 'GET').toUpperCase()
      const target = normalizeUrl(input.url)
      for (const [key, value] of Object.entries(input.query ?? {})) {
        target.searchParams.set(key, String(value))
      }

      let requestBody: string | undefined
      const extraHeaders: Record<string, string> = { ...input.headers }
      if (input.body !== undefined) {
        if (method === 'GET' || method === 'HEAD') {
          return {
            ok: false,
            reason: 'invalid-input',
            message: `${method} 不能带 body`,
            hint: '参数放到 query，或把 method 改成 POST / PUT',
            retryable: false,
          }
        }
        if (typeof input.body === 'string') {
          requestBody = input.body
        } else {
          requestBody = JSON.stringify(input.body)
          if (!Object.keys(extraHeaders).some((key) => key.toLowerCase() === 'content-type')) {
            extraHeaders['Content-Type'] = 'application/json'
          }
        }
      }

      const ref = makeRef('web-request', method, target.href, requestBody ?? '', config.pageLines)
      const hit = this.cache.get(ref, config.cacheTtlMs)
      if (hit) return { ok: true, data: present(hit, input.page, true, 'web-request') }

      const started = Date.now()
      const response = await fetchGuarded(target.href, {
        method,
        headers: browserHeaders(config.userAgent, extraHeaders),
        ...(requestBody !== undefined ? { body: requestBody } : {}),
        timeoutMs: config.timeoutMs,
        maxBytes: config.maxBytes,
        allowPrivateNetwork: config.allowPrivateNetwork,
      })
      const html = looksLikeHtml(response.contentType, response.text)
        ? toReadableText(response, this.logger)
        : null
      const text = html
        ? html.text
        : /json/i.test(response.contentType)
          ? prettyJson(response.text)
          : response.text.replace(/\r\n?/g, '\n')
      const doc = buildDoc({
        ref,
        url: target.href,
        response,
        text,
        pageLines: config.pageLines,
        title: html?.title ?? null,
        extra: { redirects: response.redirects, method, headers: response.headers },
      })
      this.cache.put(doc)
      this.logger.info('tool_worker.web_request', {
        requestId: request.requestId,
        url: target.href,
        method,
        status: response.status,
        bytes: response.bytes,
        pages: doc.pages,
        durationMs: Date.now() - started,
      })
      return {
        ok: true,
        data: present(doc, input.page, false, 'web-request', html?.note ? { note: html.note } : {}),
      }
    } catch (error) {
      if (error instanceof WebToolError) {
        return {
          ok: false,
          reason: error.reason,
          message: error.message,
          ...(error.hint ? { hint: error.hint } : {}),
          retryable: error.retryable,
        }
      }
      const reason = error instanceof Error ? error.message : String(error)
      this.logger.error('tool_worker.web_request_failed', {
        requestId: request.requestId,
        reason,
      })
      return {
        ok: false,
        reason: 'exec-failed',
        message: `HTTP 请求失败：${reason}`,
        retryable: true,
      }
    }
  }
}
