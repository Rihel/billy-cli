import { Inject, Injectable } from '@nestjs/common'
import { z } from 'zod'
import { AppLogger } from '@repo/kits'
import { CapabilityDecl, CapabilityGroup, findCapabilityDecl } from '@repo/capability'
import type { ToolInvokeRequest, ToolOutcome } from '@repo/contracts'
import {
  BROWSER_UA,
  SITE_FALLBACKS,
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
import { ToolWorkerConfig, type ToolWorkerConfigValue } from '../../config/app-config.js'

/** 声明里那份 zod 解析出来的形状（机制包宽类型丢了推导，这里补一处结构断言） */
interface WebFetchInput {
  url?: string
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
  via?: string
  headers?: Record<string, string>
  next?: string
  notice?: string
}

const normalizeUrl = (raw: string): URL => {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new WebToolError(
      `不是合法的 URL：${raw}`,
      '要带协议与主机名，例如 https://example.com/docs?id=1',
    )
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebToolError(`只支持 http / https，收到的是 ${url.protocol}`, '换成网页或 API 的地址')
  }
  return url
}

const toReadableText = (
  response: WebResponse,
  logger: AppLogger,
): { text: string; title: string | null; note?: string; blocked?: string } => {
  if (!looksLikeHtml(response.contentType, response.text)) {
    return { text: response.text.replace(/\r\n?/g, '\n'), title: null }
  }
  const title = extractTitle(response.text)
  const blocked = detectAntiBot({ status: response.status, title, html: response.text })
  if (blocked) {
    return {
      text: '',
      title,
      blocked,
      note: `这个站点有反爬 / 人机验证（${blocked}），静态抓取拿不到正文 —— 换一个来源，不要反复重试同一个地址`,
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
    return {
      text: '',
      title,
      note: '页面没有可读正文（多半是纯 JS 渲染的站点，静态抓取拿不到内容）—— 换一个来源，或找它的 API / RSS',
    }
  }
  return { text, title }
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
  extra: { note?: string; via?: string } = {},
): WebPageOutput => {
  const view: PageView = pageOf(doc, page)
  const footer = footerOf(view, doc.pageLines)
  const content = view.content ? `${view.content}\n\n---\n\n${footer}` : footer
  const notices: string[] = []
  if (view.notice) notices.push(view.notice)
  if (doc.truncated) {
    notices.push('内容超过读取上限，后面还有但没抓回来（要全量就找它的分页接口 / 下载链接）')
  }
  if (extra.note) notices.push(extra.note)
  const next = view.isLast
    ? undefined
    : `还有 ${view.remaining} 页：再调一次 ${toolKey}，传 ref="${doc.ref}"、page=${view.page + 1}（不要重传 url）`
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
    ...(extra.via ? { via: extra.via } : {}),
    ...(headers ? { headers } : {}),
    ...(next ? { next } : {}),
    ...(notices.length ? { notice: notices.join('；') } : {}),
  }
}

/**
 * web-fetch 执行器。
 *
 * 出网 / 反爬 / Markdown / 分页都复用 `@repo/web-runtime`（server 本地路径同一份代码）。
 * 配置来自 worker env（`TOOL_WEB_FETCH_*`）—— worker 不读 DB，所以不给每工具配置；
 * 需要按工具改参时，再把 settings 放进契约由 gateway 下发。
 */
@Injectable()
@CapabilityGroup({ risk: 'read' })
export class WebFetchExecutor {
  private readonly cache = new WebCache()

  constructor(
    @Inject(ToolWorkerConfig) private readonly config: ToolWorkerConfigValue,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  @CapabilityDecl({
    tool: 'web-fetch',
    title: '抓取网页（转 Markdown，按页读）',
    description: [
      '抓取一个网页，HTML 转成 Markdown 后按页返回。',
      '',
      '用在：答案在某个网页上（文档 / 公告 / 文章），但你手上没有、或可能过时。',
      '不用：要调 JSON 接口、要 POST → web-request；登录 / 强反爬站点抓不到，别反复试。',
      '',
      '读法：document 是全文规模（字符/行/页），content 是本页，页脚写"共几页 / 第几页 / 还剩几页"。',
      '续页用 ref + page；via 非空 = 正文被反爬拦了，走的是官方摘要接口（是摘要，不是全文）。',
    ].join('\n'),
    input: z.object({
      url: z.string().min(1).max(2048).optional().describe('要抓的网页地址；首次抓取必填'),
      ref: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe('上一次抓取返回的缓存句柄；读后续页时传它'),
      page: z
        .number()
        .int()
        .positive()
        .default(1)
        .describe('要第几页（从 1 开始，1 页 = 1000 行）'),
    }),
  })
  async webFetch(request: ToolInvokeRequest): Promise<ToolOutcome> {
    // 与登记同一份入参
    const parsed = findCapabilityDecl(this, 'web-fetch').input.safeParse(request.input)
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: `web-fetch 参数不合法：${parsed.error.issues[0]?.message ?? '未知错误'}`,
        retryable: false,
      }
    }
    const input = parsed.data as WebFetchInput
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
        if (cached) return { ok: true, data: present(cached, input.page, true, 'web-fetch') }
        if (!input.url) {
          return {
            ok: false,
            reason: 'invalid-input',
            message: `缓存里已经没有 ${input.ref} 了（超过 ${Math.round(config.cacheTtlMs / 60_000)} 分钟，或换到了别的 worker）`,
            hint: '重新传 url 抓一次；已经读过的页不用重读',
            retryable: false,
          }
        }
      }
      if (!input.url) {
        return {
          ok: false,
          reason: 'invalid-input',
          message: '既没有 url 也没有 ref',
          hint: '首次抓取要传 url',
          retryable: false,
        }
      }

      const target = normalizeUrl(input.url)
      const ref = makeRef('web-fetch', target.href, config.pageLines)
      const hit = this.cache.get(ref, config.cacheTtlMs)
      if (hit) return { ok: true, data: present(hit, input.page, true, 'web-fetch') }

      const started = Date.now()
      const response = await fetchGuarded(target.href, {
        headers: browserHeaders(config.userAgent),
        timeoutMs: config.timeoutMs,
        maxBytes: config.maxBytes,
        allowPrivateNetwork: config.allowPrivateNetwork,
      })
      let body = toReadableText(response, this.logger)
      let via: string | undefined

      if (!body.text.trim()) {
        const site = SITE_FALLBACKS.find((fallback) => fallback.match(target))
        if (site) {
          try {
            const got = await site.fetch(target, {
              userAgent: config.userAgent,
              timeoutMs: config.timeoutMs,
              maxBytes: config.maxBytes,
            })
            if (got?.text.trim()) {
              body = { text: got.text, title: got.title ?? body.title, note: got.note }
              via = site.name
            }
          } catch (error) {
            this.logger.warn('tool_worker.web_site_fallback_failed', {
              url: target.href,
              site: site.name,
              error: String(error),
            })
          }
        }
      }

      const doc = buildDoc({
        ref,
        url: target.href,
        response,
        text: body.text,
        pageLines: config.pageLines,
        title: body.title,
        extra: { redirects: response.redirects },
      })
      if (via) {
        doc.status = 200
        doc.contentType = 'text/markdown; charset=utf-8'
      }
      this.cache.put(doc)
      this.logger.info('tool_worker.web_fetch', {
        requestId: request.requestId,
        url: target.href,
        finalUrl: response.finalUrl,
        status: response.status,
        via: via ?? null,
        bytes: response.bytes,
        chars: doc.chars,
        pages: doc.pages,
        truncated: response.truncated,
        durationMs: Date.now() - started,
      })
      return {
        ok: true,
        data: present(doc, input.page, false, 'web-fetch', {
          ...(body.note ? { note: body.note } : {}),
          ...(via ? { via } : {}),
        }),
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
      this.logger.error('tool_worker.web_fetch_failed', {
        requestId: request.requestId,
        reason,
      })
      return {
        ok: false,
        reason: 'exec-failed',
        message: `网页抓取失败：${reason}`,
        retryable: true,
      }
    }
  }
}
