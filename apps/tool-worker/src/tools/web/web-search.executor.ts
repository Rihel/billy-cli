import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import { WEB_SEARCH_TOOL } from '@repo/tool-catalog'
import { SearchToolError, WebToolError, searchWeb, type SearchItem } from '@repo/web-runtime'
import type { ToolInvokeRequest, ToolOutcome } from '@repo/contracts'
import { ToolWorkerConfig, type ToolWorkerConfigValue } from '../../config/app-config.js'
import type { ToolExecutor } from '../../executors/tool.executor.js'

const SEARCH_MAX_CONTENT_CHARS = 1200

interface WebSearchItem {
  title: string
  url: string
  snippet: string
  summary: string
  site: string | null
  date: string | null
  score: number
  authority: number
  content?: string
  contentTruncated?: boolean
}

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

/**
 * web-search 执行器：密钥由 gateway 从 `ai_tools.secrets` 下发（`settings.secrets.apiKey`），
 * 也支持 worker 部署级 `TOOL_WEB_SEARCH_API_KEY` 兜底；出网复用 `@repo/web-runtime` 的搜索客户端。
 */
@Injectable()
export class WebSearchExecutor implements ToolExecutor {
  readonly key = 'web-search'

  constructor(
    @Inject(ToolWorkerConfig) private readonly config: ToolWorkerConfigValue,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async execute(request: ToolInvokeRequest): Promise<ToolOutcome> {
    const parsed = WEB_SEARCH_TOOL.params.safeParse(request.input)
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: `web-search 参数不合法：${parsed.error.issues[0]?.message ?? '未知错误'}`,
        retryable: false,
      }
    }
    const input = parsed.data
    const settings = request.settings
    const apiKey = settings?.secrets.apiKey ?? process.env.TOOL_WEB_SEARCH_API_KEY
    if (!apiKey) {
      return {
        ok: false,
        reason: 'precheck-failed',
        message: '没有可用的 DeepSeek 搜索密钥',
        hint: '在后台给 web-search 配置 API Key，或给 worker 配 TOOL_WEB_SEARCH_API_KEY',
        retryable: false,
      }
    }

    const config = settings?.config ?? {}
    const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl : 'https://api.deepseek.com'
    const timeoutMs =
      typeof config.timeoutMs === 'number' ? config.timeoutMs : this.config.web.timeoutMs
    const allowPrivateNetwork =
      typeof config.allowPrivateNetwork === 'boolean'
        ? config.allowPrivateNetwork
        : this.config.web.allowPrivateNetwork

    try {
      const { items } = await searchWeb({
        baseUrl,
        apiKey,
        query: input.query,
        count: input.count,
        needContent: input.needContent,
        ...(input.question ? { question: input.question } : {}),
        timeoutMs,
        allowPrivateNetwork,
      })
      const results = items.map((item) => toSearchItem(item, input.needContent))
      const truncated = results.some((item) => item.contentTruncated)
      return {
        ok: true,
        data: {
          query: input.query,
          returned: results.length,
          results,
          ...(results.length === 0
            ? { notice: '没有匹配结果；换关键词，或直接用 web-fetch 抓已知地址' }
            : {}),
          ...(truncated
            ? { notice: '部分正文超过上限已截断；要看全文用 web-fetch 打开该 url' }
            : {}),
          ...(results.length > 0
            ? { next: '选合适的 url 用 web-fetch 读正文；摘要不够判断时再 needContent=true' }
            : {}),
        },
      }
    } catch (error) {
      if (error instanceof SearchToolError) {
        return {
          ok: false,
          reason: error.reason,
          message: error.message,
          ...(error.hint ? { hint: error.hint } : {}),
          retryable: error.retryable,
        }
      }
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
      this.logger.error('tool_worker.web_search_failed', {
        requestId: request.requestId,
        reason,
      })
      return {
        ok: false,
        reason: 'exec-failed',
        message: `搜索失败：${reason}`,
        retryable: true,
      }
    }
  }
}
