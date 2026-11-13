import dedent from 'dedent'
import { Inject, Injectable } from '@nestjs/common'
import { z } from 'zod'
import { AppLogger } from '@repo/kits'
import { ToolDecl, ToolGroup } from '../core/tools/tool.decorator.js'
import { TOOL_KEYS } from '../core/tools/tool-keys.js'
import { ToolDeniedError } from '../core/tools/tools.types.js'
import type { ToolCallContext, ToolEnvCaps } from '../core/tools/tools.types.js'
import { BROWSER_UA, browserHeaders, fetchGuarded, type WebResponse } from './web/http.js'
import {
  detectAntiBot,
  extractTitle,
  htmlToMarkdown,
  htmlToPlainText,
  looksLikeHtml,
} from './web/markdown.js'
import { SITE_FALLBACKS } from './web/sites.js'
import { searchWeb, type SearchItem } from './web/search.js'
import {
  WebCache,
  footerOf,
  makeRef,
  pageOf,
  splitPages,
  type CachedDoc,
  type PageView,
} from './web/pager.js'

/**
 * **联网工具组**：`web-fetch`（读网页）+ `web-request`（调接口）+ `web-search`（搜来源）。
 *
 * 为什么是三个而不是一个：
 * - `web-fetch` 是**给模型读的**：一次 GET，把 HTML 洗成 Markdown，噪声全丢掉。
 *   模型 90% 的"读"是这个（读文档、读公告、读文章）；
 * - `web-request` 是**给模型调的**：要 POST、要自定义头、要拿 JSON API、要看状态码。
 *   它不洗正文（除非对方回 HTML），因为 JSON 洗了就没法用了；
 * - `web-search` 是**最后手段**：确实不知道答案在哪个网页时，才用关键词换一批候选来源
 *   （标题 / 链接 / 摘要 / 发布时间 / 相关度 / 权威度）。它调的是 DeepSeek 搜索接口，按次计费。
 *
 * **默认顺序是"先直取、再搜"**：手上有 URL 就 `web-fetch`、有接口地址就 `web-request`；
 * 只有确实不知道去哪找才 `web-search`，拿到 URL 后仍然回到 `web-fetch` 读正文。
 * 搜索只给摘要与 URL，不搬正文 —— 于是"搜到什么"与"读到什么"在时间线上分得清，
 * 模型也不会因为一次搜索就把多页正文塞满上下文。
 *
 * 抓取与请求共用三件事（都在 `web/` 里各写一份）：
 * 1. **出网**：统一浏览器 UA、同一份超时 / 字节预算、逐跳校验内网地址（`web/http.ts`）；
 * 2. **分页**：按**行**切、1 页 1000 行，页脚明确写"共几页 / 当前第几页 / 还剩几页"（`web/pager.ts`）；
 * 3. **缓存**：抓一次，全文进进程内缓存，翻页只切片不再发请求；`ref` 就是取页句柄。
 *
 * 搜索不分页：它返回的是**有限条摘要**（条数由 `count` 控制，工具侧再按字符截断正文），
 * 一次就能装下；需要更多来源就换关键词再搜，而不是"翻第 2 页"。
 *
 * 为什么不挂引擎的 `paginate` 声明：那套按字节切，网页正文会切在句子中间，
 * 而且取下一页要走 `read-tool-result`（模型得先知道有这个工具）。
 * 这里把分页做进工具自己的出参：**同一个工具、同一个 ref、换个 page** 就接着读，路径最短。
 */

// ─────────────────────────── 参数 / 配置 ───────────────────────────

const WebFetchParams = z.object({
  url: z
    .string()
    .min(1)
    .max(2048)
    .optional()
    .describe(
      '要抓的网页地址（http / https，要带协议）。**首次抓取必填**；只为了读下一页时可以省略，只传 ref',
    ),
  ref: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      '上一次抓取返回的缓存句柄。**读后续页时传它**：服务端从缓存切片，不会重新发起请求。过期或服务重启后失效',
    ),
  page: z
    .number()
    .int()
    .positive()
    .default(1)
    .describe(
      '要第几页（从 1 开始，1 页 = 1000 行）。默认第 1 页；每页结尾的页脚写着总页数与还剩几页',
    ),
})

const WebRequestParams = z.object({
  url: z
    .string()
    .min(1)
    .max(2048)
    .optional()
    .describe('请求地址（http / https，要带协议）。**首次请求必填**；只为了读下一页时可以省略'),
  method: z
    .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
    .default('GET')
    .describe('HTTP 方法，默认 GET'),
  query: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe('查询参数（自动 URL 编码）。地址里已经带 `?a=1` 也能用，这里的是补充 / 覆盖'),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      '自定义请求头。默认已带好一整套浏览器头（UA / Accept / Accept-Language / Sec-Fetch-*），这里给的**会覆盖**同名默认项',
    ),
  body: z
    .union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
    .optional()
    .describe(
      '请求体。字符串原样发；对象 / 数组自动转 JSON 并补 `Content-Type: application/json`。GET / HEAD 不能带',
    ),
  ref: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('上一次请求返回的缓存句柄。**读后续页时传它**，服务端从缓存切片不再请求'),
  page: z.number().int().positive().default(1).describe('要第几页（从 1 开始，1 页 = 1000 行）'),
})

/** 搜索的入参：只给"找来源"需要的东西，正文交给 `web-fetch` */
const WebSearchParams = z.object({
  query: z
    .string()
    .min(1)
    .max(128)
    .describe(
      '搜索词（1~128 字符）。支持 site: / -site: / "精确短语" / -词 / lang:zh,en / after:2025-01-01 / before:2026',
    ),
  count: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(8)
    .describe('返回多少条（1~20，默认 8）。条数只影响上下文大小，不影响计费（按请求次数计费）'),
  needContent: z
    .boolean()
    .default(false)
    .describe('是否顺带抓回网页正文（默认 false）。为 true 时每条正文会被截断，摘要不够判断时再用'),
  question: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe('用户的原始问题（可选）：原样传用户那句话，帮助搜索引擎理解意图'),
})

/**
 * 搜索的秘钥：**可不填**。
 *
 * 不填时回落到"当前这一轮模型的密钥"（仅当模型供应商是 DeepSeek 官方、且没配自定义 baseURL）——
 * 搜索与对话是同一个 DeepSeek 账号、同一把密钥，重复录入没有价值；
 * 但**显式填了就以填的为准**（换账号 / 换代理时不用去改模型配置）。
 */
const WebSearchSecrets = z.object({
  apiKey: z.string().min(1).optional(),
})

/** 两个抓取工具共用一份配置定义：同一套网络预算与分页口径，分开放必然漂移 */
const WebConfig = z.object({
  /** 能力级开关（配置表里还有治理级开关 `enabled`，两者都开才放行；env 也有一道） */
  enabled: z.boolean().default(true),
  /** 单次请求的总时长上限（ms）：整条重定向链共用这一个预算 */
  timeoutMs: z.number().int().positive().default(20_000),
  /** 最多读多少字节（超出即截断，出参里 `truncated: true`） */
  maxBytes: z
    .number()
    .int()
    .positive()
    .default(2 * 1024 * 1024),
  /** 一页多少行：分页口径（1000 行大致是 3~5 万字符，够一个完整章节） */
  pageLines: z.number().int().positive().default(1000),
  /** 缓存多久（ms）：期内翻页不发请求；过期后 ref 失效，需要重新抓 */
  cacheTtlMs: z
    .number()
    .int()
    .positive()
    .default(10 * 60_000),
  /** 统一 UA（所有出网请求共用；换身份只改这一处） */
  userAgent: z.string().min(16).default(BROWSER_UA),
  /**
   * 是否允许访问内网 / 回环地址（默认关）。
   *
   * 关着的时候 `127.0.0.1`、`10.x`、云元数据 `169.254.169.254` 一律拒绝 ——
   * 网页内容可以诱导模型去请求这些地址，这是 SSRF 的常规入口。
   * 自用环境要抓本机服务时打开；**部署环境还要 env 也打开**（两层开关）。
   */
  allowPrivateNetwork: z.boolean().default(false),
})

type WebConfigValue = z.infer<typeof WebConfig>

/**
 * 搜索的配置：**不共用 `WebConfig`**。
 *
 * 抓取是"用户给 URL，我们出网"，搜索是"调固定的 DeepSeek 接口"；两者共享的只有
 * 超时与内网闸（都按 `AGENT_WEB_*` 夹紧）。把 baseUrl 与秘钥塞进抓取配置，只会让两边的
 * 开关与预算互相牵制。
 */
const WebSearchConfig = z.object({
  /** 能力级开关（与治理级开关、env 三层都开才放行） */
  enabled: z.boolean().default(true),
  /** 接口地址：**只填到域名 / 端口**，路径由 `web/search.ts` 拼 `/v1/tools/search` */
  baseUrl: z.string().url().max(255).default('https://api.deepseek.com'),
  /** 单次搜索的总时长上限（ms） */
  timeoutMs: z.number().int().positive().default(15_000),
  /** 允许访问内网 / 回环地址（自建代理或本机 mock 时打开；部署环境还要 env 也打开） */
  allowPrivateNetwork: z.boolean().default(false),
})

type WebSearchConfigValue = z.infer<typeof WebSearchConfig>

/** 出参（两个工具同形：模型读一次就知道怎么翻页） */
export interface WebPageOutput {
  /** 缓存句柄：读下一页把它传回来 */
  ref: string
  url: string
  finalUrl: string
  status: number
  contentType: string
  title: string | null
  /** 这一页是从缓存切的（没有发请求） */
  cached: boolean
  /** 内容超过字节上限被截断了 */
  truncated: boolean
  /** 全文规模：模型据此决定"读一页够不够" */
  document: {
    chars: number
    bytes: number
    lines: number
    pages: number
    pageLines: number
    fetchedAt: string
  }
  /** 本页位置 */
  page: { current: number; total: number; remaining: number; isLast: boolean }
  /** 本页正文（末尾已带页脚） */
  content: string
  /** 页脚：共几页 / 当前第几页 / 还剩几页（最后一页直说"最后一页"） */
  footer: string
  /** 响应头（只 `web-request` 给：调接口时 `content-type` / `location` 这类是判断依据） */
  headers?: Record<string, string>
  /** 内容不是从 `url` 直接抓来的，而是走了站点的官方兜底通道（如百度百科的公开摘要接口） */
  via?: string
  /** 还有下一页时怎么取 */
  next?: string
  /** 额外说明（页码越界、正文为空、被截断等） */
  notice?: string
}

/** 搜索结果的一条（给模型看的字段；`content` 只有 `needContent` 才有） */
export interface WebSearchItem {
  title: string
  url: string
  /** 短摘要（100~200 字符，判断"要不要点开"够用） */
  snippet: string
  /** 长摘要（600~800 字符，适合直接读） */
  summary: string
  site: string | null
  /** 发布时间（UTC ISO）；未知为 null */
  date: string | null
  /** 相关度综合分 0~3（≥1.5 为优质） */
  score: number
  /** 权威性 0~4（≥3 极权威；-1 未知） */
  authority: number
  /** 正文（仅 `needContent` 为 true；超过上限会截断并标记） */
  content?: string
  /** 正文被截断了（要看全文就 `web-fetch` 这个 url） */
  contentTruncated?: boolean
}

/** 搜索出参：一批来源 + 下一步怎么用 */
export interface WebSearchOutput {
  query: string
  /** 实际返回了几条（空数组 = 正常结束但没有匹配） */
  returned: number
  results: WebSearchItem[]
  /** 有结果时：怎么读其中的正文 */
  next?: string
  /** 额外说明（空结果、正文被截断等） */
  notice?: string
}

const WEB_SEARCH_DESCRIPTION = dedent`
  搜索网页：给关键词，返回按相关度排序的来源清单（标题 / 链接 / 摘要 / 发布时间 / 权威度）。

  用在：确实不知道答案在哪个网页上，或要多个来源交叉核对。

  \`score\` ≥ 1.5 为优质，\`authority\` ≥ 3 为极权威。
`

const WEB_FETCH_DESCRIPTION = dedent`
  抓取一个网页，HTML 转成 Markdown 后按页返回。

  用在：答案在某个**网页**上（文档 / 公告 / 文章），但你手上没有、或可能过时。
  不用：要调 JSON 接口、要 POST → \`web-request\`；登录 / 强反爬站点抓不到，别反复试。

  读法：\`document\` 是全文规模（字符/行/页），\`content\` 是本页，页脚写"共几页 / 第几页 / 还剩几页"。
  续页用 \`ref\` + \`page\`（参数说明见下）；\`via\` 非空 = 正文被反爬拦了，走的是官方摘要接口（**是摘要，不是全文**）。
`

const WEB_REQUEST_DESCRIPTION = dedent`
  发起一次 HTTP 请求（GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS），按页返回状态码、响应头与响应体。

  用在：目标是**接口** —— JSON API、要 POST、要看状态码、要自定义头、要读 RSS / XML。
  不用：只是读网页 → \`web-fetch\`（它会把 HTML 洗成 Markdown）。

  非 2xx 不算失败，状态码与响应体照样返回。续页用 \`ref\` + \`page\`。
  只请求需要的接口；不要外发响应里的凭据。
`

// ─────────────────────────── 工具组 ───────────────────────────

@Injectable()
@ToolGroup({
  // 运行时能力（与具体业务无关）
  category: 'core',
  scope: 'all',
  // 子 agent 也该能联网：它常常就是被派去查资料的那一个
  child: 'allow',
})
export class WebTools {
  /** 一次抓取只发一次请求的落地处：翻页全在内存里切片 */
  private readonly cache = new WebCache()

  constructor(@Inject(AppLogger) private readonly logger: AppLogger) {}

  /**
   * **搜索**：调 DeepSeek 搜索接口，拿回一批来源。
   *
   * 只做"找"，不做"读"：正文由 `web-fetch` 取。这样一次搜索的出参是**有限条摘要**，
   * 模型先判断哪几条值得读，再把上下文花在真正需要的页面上。
   */
  @ToolDecl({
    key: TOOL_KEYS.webSearch,
    title: '搜索网页（先找来源，再读）',
    params: WebSearchParams,
    config: WebSearchConfig,
    secrets: WebSearchSecrets,
    secretFields: [
      {
        name: 'apiKey',
        label: 'DeepSeek API Key（留空则复用当前会话 DeepSeek 官方模型的密钥）',
      },
    ],
    precheck: 'checkSearch',
    normalize: 'normalizeSearchConfig',
    description: WEB_SEARCH_DESCRIPTION,
  })
  async search(
    input: z.infer<typeof WebSearchParams>,
    ctx: ToolCallContext<WebSearchConfigValue>,
  ): Promise<WebSearchOutput> {
    const config = ctx.settings.config
    const apiKey = this.searchApiKey(ctx)
    // precheck 已经拦过"没有密钥"；这里再判一次是为了让类型收窄，不依赖插件的执行顺序
    if (!apiKey) {
      throw new ToolDeniedError(
        'precheck-failed',
        '没有可用的 DeepSeek 密钥',
        '在后台给 web-search 配置 API Key，或改用 DeepSeek 官方模型',
      )
    }

    const started = Date.now()
    const { items } = await searchWeb({
      baseUrl: config.baseUrl,
      apiKey,
      query: input.query.trim(),
      count: input.count,
      needContent: input.needContent,
      ...(input.question ? { question: input.question } : {}),
      timeoutMs: config.timeoutMs,
      allowPrivateNetwork: config.allowPrivateNetwork,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })

    // 没有 url 的结果对模型没用（点不开、也读不到），直接丢掉
    const results = items
      .filter((item) => item.url)
      .map((item) => toSearchItem(item, input.needContent))

    this.logger.info('ai.web.search', {
      query: input.query,
      count: input.count,
      returned: results.length,
      needContent: input.needContent,
      durationMs: Date.now() - started,
    })

    if (results.length === 0) {
      return {
        query: input.query,
        returned: 0,
        results,
        notice: '没有搜到匹配结果：换关键词、去掉限定词或放宽时间范围；不要原样重试同一条 query',
      }
    }
    return {
      query: input.query,
      returned: results.length,
      results,
      next: '要读全文就调 `web-fetch` 传 url —— 挑 1~3 条最相关的，别逐条点开',
    }
  }

  /**
   * **搜索用的密钥**：显式配置优先，其次复用**当前轮 DeepSeek 官方模型**（未改 baseURL）的密钥。
   *
   * 搜索与对话是同一个 DeepSeek 账号的同一把密钥；不填时自动复用，填了就以填的为准
   * （换账号 / 换代理时不用去改模型配置）。
   *
   * 只在 `providerKind === 'deepseek'` **且没配自定义 baseURL** 时复用：自建网关 / 代理的密钥
   * 只对那个地址有效，拿来打官方接口只会得到 401。只在这一条调用链里用：不落库、不进日志、不出现在出参里。
   */
  private searchApiKey(ctx: ToolCallContext<WebSearchConfigValue>): string | null {
    const configured = ctx.settings.secret('apiKey')
    if (configured) return configured
    const model = (
      ctx.envelope as {
        model?: { providerKind?: unknown; baseURL?: unknown; apiKey?: unknown }
      } | null
    )?.model
    return model?.providerKind === 'deepseek' &&
      !model.baseURL &&
      typeof model.apiKey === 'string' &&
      model.apiKey
      ? model.apiKey
      : null
  }

  /** **只读前置条件**：有搜索词、有可用密钥（否则模型改 query 也永远搜不成） */
  checkSearch(input: { query: string }, ctx: ToolCallContext<WebSearchConfigValue>): string | null {
    if (!input.query?.trim()) return '搜索词不能为空；给一个具体的说法或一组关键词'
    if (this.searchApiKey(ctx)) return null
    return '没有可用的 DeepSeek 密钥（当前会话模型不是 DeepSeek 官方，后台也没给 web-search 配置 API Key）；换搜索词没有用，先用 web-fetch 读已知来源'
  }

  /** **搜索配置归一化**：与抓取共用同一套部署边界（env 关了就真关、超时夹到上限） */
  normalizeSearchConfig(config: WebSearchConfigValue, caps: ToolEnvCaps): WebSearchConfigValue {
    const web = caps.web
    return {
      ...config,
      enabled: config.enabled && (web?.enabled ?? true),
      timeoutMs: Math.min(config.timeoutMs, web?.timeoutMsMax ?? config.timeoutMs),
      allowPrivateNetwork: config.allowPrivateNetwork && (web?.allowPrivateNetwork ?? true),
    }
  }

  /**
   * **抓网页**：GET → 判类型 → HTML 转 Markdown → 入缓存 → 给第 N 页。
   *
   * 三条路径（按顺序）：
   * 1. `ref` 命中缓存 → 直接切片，**不发请求**（翻页的正常路径）；
   * 2. 同一份地址抓过 → 复用缓存（模型重复调同一个 url 不该再打一次网络）；
   * 3. 都没有 → 真发一次请求，全文入缓存。
   */
  @ToolDecl({
    key: TOOL_KEYS.webFetch,
    title: '抓取网页（转 Markdown，按页读）',
    params: WebFetchParams,
    config: WebConfig,
    precheck: 'checkTarget',
    normalize: 'normalizeConfig',
    description: WEB_FETCH_DESCRIPTION,
  })
  async fetchPage(
    input: z.infer<typeof WebFetchParams>,
    ctx: ToolCallContext<WebConfigValue>,
  ): Promise<WebPageOutput> {
    const config = ctx.settings.config

    // ① 翻页：ref 命中就直接切
    if (input.ref) {
      const cached = this.cache.get(input.ref, config.cacheTtlMs)
      if (cached) return present(cached, input.page, true, TOOL_KEYS.webFetch)
      if (!input.url) {
        throw new ToolDeniedError(
          'invalid-input',
          `缓存里已经没有 ${input.ref} 了（超过 ${Math.round(config.cacheTtlMs / 60_000)} 分钟，或服务重启过）`,
          '重新传 url 抓一次；已经读过的页不用重读，直接说要第几页',
        )
      }
    }
    if (!input.url) {
      throw new ToolDeniedError('invalid-input', '既没有 url 也没有 ref', '首次抓取要传 url')
    }

    // ② 同一份地址：抓过就直接复用
    const target = normalizeUrl(input.url)
    const ref = makeRef('web-fetch', target.href, config.pageLines)
    const hit = this.cache.get(ref, config.cacheTtlMs)
    if (hit) return present(hit, input.page, true, TOOL_KEYS.webFetch)

    // ③ 真抓一次
    const started = Date.now()
    const response = await fetchGuarded(target.href, {
      headers: browserHeaders(config.userAgent),
      timeoutMs: config.timeoutMs,
      maxBytes: config.maxBytes,
      allowPrivateNetwork: config.allowPrivateNetwork,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    let body = toReadableText(response, this.logger)
    let via: string | undefined

    // ④ 被拦 / 没内容时，看这个站点有没有官方兜底通道（如百度百科的公开摘要接口）
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
          this.logger.warn('ai.web.site_fallback_failed', {
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
      // 交付的是兜底接口那份内容，不是那个被拒的响应 —— 状态要跟着"这次交付"走，
      // 否则出参会变成"403 + 有正文"，模型只会当成自相矛盾的信息
      doc.status = 200
      doc.contentType = 'text/markdown; charset=utf-8'
    }
    this.cache.put(doc)
    this.logger.info('ai.web.fetch', {
      url: target.href,
      finalUrl: response.finalUrl,
      status: response.status,
      via: via ?? null,
      bytes: response.bytes,
      chars: doc.chars,
      lines: doc.lines,
      pages: doc.pages,
      truncated: response.truncated,
      durationMs: Date.now() - started,
    })
    return present(doc, input.page, false, TOOL_KEYS.webFetch, {
      ...(body.note ? { note: body.note } : {}),
      ...(via ? { via } : {}),
    })
  }

  /**
   * **发请求**：任意方法 / 头 / body，响应按类型给可读文本（JSON 展开、HTML 转 Markdown）。
   *
   * 与 `web-fetch` 共用缓存与分页：两个工具的出参同形，模型不必学两套翻页方式。
   */
  @ToolDecl({
    key: TOOL_KEYS.webRequest,
    title: '发起 HTTP 请求（JSON API / 自定义方法与头）',
    params: WebRequestParams,
    config: WebConfig,
    precheck: 'checkTarget',
    normalize: 'normalizeConfig',
    description: WEB_REQUEST_DESCRIPTION,
  })
  async call(
    input: z.infer<typeof WebRequestParams>,
    ctx: ToolCallContext<WebConfigValue>,
  ): Promise<WebPageOutput> {
    const config = ctx.settings.config

    // ① 翻页：同上，缓存命中不发请求
    if (input.ref) {
      const cached = this.cache.get(input.ref, config.cacheTtlMs)
      if (cached) return present(cached, input.page, true, TOOL_KEYS.webRequest)
      if (!input.url) {
        throw new ToolDeniedError(
          'invalid-input',
          `缓存里已经没有 ${input.ref} 了（过期或服务重启）`,
          '重新传 url / method / body 再请求一次',
        )
      }
    }
    if (!input.url) {
      throw new ToolDeniedError('invalid-input', '既没有 url 也没有 ref', '首次请求要传 url')
    }

    const method = (input.method ?? 'GET').toUpperCase()
    const target = normalizeUrl(input.url)
    if (input.query) {
      for (const [key, value] of Object.entries(input.query)) {
        target.searchParams.set(key, String(value))
      }
    }

    // body：字符串原样发；对象 / 数组自动转 JSON 并补 content-type（模型最容易漏的就是这个）
    let requestBody: string | undefined
    const extraHeaders: Record<string, string> = { ...input.headers }
    if (input.body !== undefined) {
      if (method === 'GET' || method === 'HEAD') {
        throw new ToolDeniedError(
          'invalid-input',
          `${method} 不能带 body`,
          '要传参数就放到 query 里，或者把 method 改成 POST / PUT',
        )
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
    if (hit) return present(hit, input.page, true, TOOL_KEYS.webRequest)

    const started = Date.now()
    const response = await fetchGuarded(target.href, {
      method,
      headers: browserHeaders(config.userAgent, extraHeaders),
      ...(requestBody !== undefined ? { body: requestBody } : {}),
      timeoutMs: config.timeoutMs,
      maxBytes: config.maxBytes,
      allowPrivateNetwork: config.allowPrivateNetwork,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    const isHtml = looksLikeHtml(response.contentType, response.text)
    const html = isHtml ? toReadableText(response, this.logger) : null
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
      // 只有 HTML 才谈得上"标题"；JSON / 纯文本没有
      title: html?.title ?? null,
      extra: { redirects: response.redirects, method, headers: response.headers },
    })
    this.cache.put(doc)
    this.logger.info('ai.web.request', {
      url: target.href,
      method,
      status: response.status,
      bytes: response.bytes,
      chars: doc.chars,
      pages: doc.pages,
      durationMs: Date.now() - started,
    })
    return present(
      doc,
      input.page,
      false,
      TOOL_KEYS.webRequest,
      html?.note ? { note: html.note } : {},
    )
  }

  /** **只读前置条件**：url 与 ref 至少给一个（两个都给也合法：ref 失效时退回重抓） */
  checkTarget(input: { url?: string; ref?: string }): string | null {
    if (input.url || input.ref) return null
    return '需要 url（首次抓取）或 ref（接着读下一页），两个都没给'
  }

  /**
   * **配置归一化**（纯函数）：把库里的值夹到部署边界。
   *
   * `enabled` 与 `allowPrivateNetwork` 都按"两边都开才放行"处理：
   * 部署侧（env）关掉 `AGENT_WEB_ENABLED=false`、或没开 `AGENT_WEB_ALLOW_PRIVATE_NETWORK` 时，
   * 后台把开关点开也不生效 —— 谁也没法在页面上绕出部署边界。
   */
  normalizeConfig(config: WebConfigValue, caps: ToolEnvCaps): WebConfigValue {
    const web = caps.web
    return {
      ...config,
      enabled: config.enabled && (web?.enabled ?? true),
      timeoutMs: Math.min(config.timeoutMs, web?.timeoutMsMax ?? config.timeoutMs),
      maxBytes: Math.min(config.maxBytes, web?.maxBytesMax ?? config.maxBytes),
      allowPrivateNetwork: config.allowPrivateNetwork && (web?.allowPrivateNetwork ?? true),
    }
  }
}

// ─────────────────────────── 内部实现（运行时才调用，声明放在类之后） ───────────────────────────

/**
 * 搜索结果的正文上限（字符）。
 *
 * `needContent` 是为了"摘要不够判断、又不想再多调一次 `web-fetch`"；
 * 但把整页正文随 8~20 条结果一起塞进上下文，一次就能顶满窗口。
 * 1200 字符够看清一段话的立场与要点，要全文仍然去 `web-fetch`（那条路径有分页与缓存）。
 * 写成常量而不是配置：这是**上下文预算**，不该由后台页面随手放大。
 */
const SEARCH_MAX_CONTENT_CHARS = 1200

/** 搜索结果 → 给模型的形状（正文按上限截断；不需要正文时连字段都不给） */
const toSearchItem = (item: SearchItem, needContent: boolean): WebSearchItem => {
  const base: WebSearchItem = {
    title: item.title,
    url: item.url,
    snippet: item.snippet,
    summary: item.summary,
    site: item.siteName,
    date: item.date,
    score: item.rerankScore,
    authority: item.authority,
  }
  if (!needContent || !item.content) return base
  const truncated = item.content.length > SEARCH_MAX_CONTENT_CHARS
  return {
    ...base,
    content: truncated ? `${item.content.slice(0, SEARCH_MAX_CONTENT_CHARS)}…` : item.content,
    contentTruncated: truncated,
  }
}

/** 地址规整（`new URL` 顺手把 `https://a.com` 补成 `https://a.com/`，缓存键才稳定） */
const normalizeUrl = (raw: string): URL => {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new ToolDeniedError(
      'invalid-input',
      `不是合法的 URL：${raw}`,
      '要带协议与主机名，例如 https://example.com/docs?id=1',
    )
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolDeniedError(
      'invalid-input',
      `只支持 http / https，收到的是 ${url.protocol}`,
      '换成网页或 API 的地址',
    )
  }
  return url
}

/**
 * 响应体 → 可读文本。
 *
 * HTML 走 Markdown（模型读 Markdown 比读 HTML 省一半 token，结构还在）；
 * 其它类型原样。转换失败兜底成纯文本 —— 转换器出问题不等于抓取失败，
 * "页面里的字"本身还有价值。
 */
const toReadableText = (
  response: WebResponse,
  logger: AppLogger,
): { text: string; title: string | null; note?: string; blocked?: string } => {
  if (!looksLikeHtml(response.contentType, response.text)) {
    return { text: response.text.replace(/\r\n?/g, '\n'), title: null }
  }
  const title = extractTitle(response.text)
  // 先判"被拦"：403 的正文同样是空的，但**结论完全不同** ——
  // 说成"页面没内容"模型会反复重试，说成"被反爬拦了"它才会换来源（见 `detectAntiBot`）
  const blocked = detectAntiBot({ status: response.status, title, html: response.text })
  if (blocked) {
    return {
      text: '',
      title,
      blocked,
      note: `这个站点有反爬 / 人机验证（${blocked}），静态抓取拿不到正文 —— 换一个来源（维基百科、官方文档、镜像站），不要反复重试同一个地址`,
    }
  }
  let text = ''
  try {
    text = htmlToMarkdown(response.text)
  } catch (error) {
    logger.warn('ai.web.markdown_failed', { url: response.finalUrl, error: String(error) })
  }
  if (!text.trim()) text = htmlToPlainText(response.text)
  if (!text.trim()) {
    // 纯 JS 渲染的站点：HTTP 200、body 里只有一个空 div。这件事必须说出来，
    // 否则模型会以为"这个页面什么都没有"，而不是"这个页面抓不到"
    return {
      text: '',
      title,
      note: '页面没有可读正文（多半是纯 JS 渲染的站点，静态抓取拿不到内容）—— 换一个来源，或找它的 API / RSS',
    }
  }
  return { text, title }
}

/** JSON 美化：压缩成一行的 JSON 模型读起来极费劲，展开后可读性与行数都更像文档 */
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

/**
 * 取一页并拼出参。
 *
 * 页脚**写在正文末尾**（而不是只放在页头字段里）：模型读到哪儿，"还有几页"那句话就在哪儿，
 * 它不必回头找字段也不会漏看。
 */
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
    notices.push(
      '内容超过读取上限，后面还有但没抓回来（要全量就找它的分页接口 / 下载链接，别重复抓同一页）',
    )
  }
  if (extra.note) notices.push(extra.note)
  const next = view.isLast
    ? undefined
    : `还有 ${view.remaining} 页：再调一次 ${toolKey}，传 ref="${doc.ref}"、page=${view.page + 1}（**不要重传 url**，缓存里直接切）`
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
