import { AiProviderKind } from '@repo/shared'
import { ModelSyncFailedError } from './errors.js'

/**
 * "列模型"适配层（**纯函数 + 一次 fetch，可脱离数据库单测**）。
 *
 * 供应商的"列模型"接口形态不统一，所以按 `kind` 分派（见设计文档 §4.8.2）；
 * 解析结果统一成 {@link RemoteModel}，"新增一家 = 加一个 adapter + 登记一行"。
 *
 * 四条硬口径：
 * - **容错解析**：字段缺失不报错（拿不到就是 `undefined`），但**绝不编造** ——
 *   拿不到上下文窗口就是 `null`，不猜一个"看起来合理"的数；
 * - **非 2xx 带原文**：错误信息里带响应体前 300 字符（排障要看供应商原话）；
 * - **超时**：`AbortSignal.timeout`，默认 15s，避免一个卡死的网关把同步拖到天荒地老；
 * - **翻页上限 10 页**：防供应商 `has_more` / `nextPageToken` 永远为真的死循环。
 */

/** 供应商侧的一个模型（解析后的统一形态） */
export interface RemoteModel {
  /** 供应商侧的模型 id（Gemini 已去掉 `models/` 前缀） */
  modelKey: string
  /** 展示名（Anthropic `display_name` / Gemini `displayName`；OpenAI 形态没有则不编造） */
  displayName?: string
  /** 上下文窗口（拿不到就是 undefined） */
  contextWindow?: number
  /** 单次输出上限（拿不到就是 undefined） */
  maxOutputTokens?: number
  /** 能力标记（如 Gemini 的 `supportedGenerationMethods`）；拿不到就是 undefined */
  capabilities?: Record<string, unknown>
  /** 供应商原始 JSON（**全量留存、不裁剪**，原样进 `ai_models.raw`） */
  raw: Record<string, unknown>
}

export interface ListProviderModelsInput {
  /** 供应商类型（见 `AiProviderKind` 字典） */
  kind: string
  /** 接口地址；留空用该 kind 的官方默认地址（openai-compatible 没有官方默认，必须配） */
  baseUrl?: string | null
  /** 供应商密钥明文（只在内存里流转） */
  apiKey: string
  /** 超时（ms）；默认 15s */
  timeoutMs?: number
}

export interface ListProviderModelsResult {
  /** 实际请求的第一个地址（排障第一步：确认打到了哪） */
  endpoint: string
  models: RemoteModel[]
}

/** 默认超时（ms） */
export const DEFAULT_SYNC_TIMEOUT_MS = 15_000
/** 翻页上限（防死循环） */
export const MAX_PAGES = 10
/** 非 2xx 时带进错误信息的响应体长度上限 */
const ERROR_BODY_MAX = 300

/** 各 kind 的官方默认地址；`openai-compatible` **刻意没有**默认（自建网关 / 代理必须手填） */
export const DEFAULT_PROVIDER_BASE_URLS: Record<string, string> = {
  [AiProviderKind.Openai]: 'https://api.openai.com/v1',
  [AiProviderKind.Anthropic]: 'https://api.anthropic.com/v1',
  [AiProviderKind.Google]: 'https://generativelanguage.googleapis.com/v1beta',
}

/** 去掉末尾斜杠（避免拼出 `//models`） */
const trimSlash = (value: string): string => value.replace(/\/+$/, '')

/** 解析基地址：显式配置优先，否则回落该 kind 的官方默认 */
const resolveBaseUrl = (kind: string, baseUrl?: string | null): string => {
  const configured = baseUrl?.trim()
  if (configured) return trimSlash(configured)
  const fallback = DEFAULT_PROVIDER_BASE_URLS[kind]
  if (!fallback) {
    throw new ModelSyncFailedError(
      `供应商类型「${kind}」没有官方默认地址，必须配置 baseUrl（如自建网关的 https://host/v1）`,
    )
  }
  return fallback
}

const endpointOf = (baseUrl: string, path: string, query?: URLSearchParams): string => {
  const suffix = query && query.size > 0 ? `?${query.toString()}` : ''
  return `${trimSlash(baseUrl)}${path}${suffix}`
}

const truncate = (text: string, max = ERROR_BODY_MAX): string =>
  text.length > max ? `${text.slice(0, max)}…(已截断)` : text

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * 发一次 GET 并解析 JSON。
 *
 * 所有失败（网络 / 超时 / 非 2xx / 非 JSON）都转成 {@link ModelSyncFailedError}（3403），
 * 并带上**实际请求地址**与供应商原文，保证上层（service / 页面）能原样展示。
 */
const getJson = async (
  endpoint: string,
  init: { headers: Record<string, string> },
  timeoutMs: number,
): Promise<Record<string, unknown>> => {
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      headers: init.headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new ModelSyncFailedError(
      `请求供应商接口失败：${messageOf(error)}（地址 ${endpoint}）`,
      endpoint,
    )
  }

  const text = await response.text()
  if (!response.ok) {
    throw new ModelSyncFailedError(
      `供应商接口返回 HTTP ${response.status}：${truncate(text)}（地址 ${endpoint}）`,
      endpoint,
    )
  }
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new ModelSyncFailedError(
      `供应商接口返回的不是合法 JSON：${truncate(text)}（地址 ${endpoint}）`,
      endpoint,
    )
  }
}

/** 正整数解析：非数字 / 非正数一律当作"拿不到"（undefined） */
const toPositiveInt = (value: unknown): number | undefined => {
  const num =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(num) && num > 0 ? Math.trunc(num) : undefined
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

// ─────────────────────────── OpenAI（含 openai-compatible） ───────────────────────────

/**
 * OpenAI 形态：`GET {base}/models`，`Authorization: Bearer <key>`，
 * 取 `data[]` 的 `id` / `created` / `owned_by`（本仓 mock 服务按此形态实现，已实测）。
 *
 * `openai` 与 `openai-compatible` 是**同一个 adapter**：差别只在默认地址
 * （前者有官方端点，后者必须显式配 baseUrl）。
 */
const listOpenAiModels = async (
  input: ListProviderModelsInput,
  timeoutMs: number,
): Promise<ListProviderModelsResult> => {
  const endpoint = endpointOf(resolveBaseUrl(input.kind, input.baseUrl), '/models')
  const body = await getJson(
    endpoint,
    { headers: { authorization: `Bearer ${input.apiKey}`, accept: 'application/json' } },
    timeoutMs,
  )
  const models: RemoteModel[] = []
  for (const item of asArray(body.data)) {
    const record = asRecord(item)
    const modelKey = record ? asString(record.id) : undefined
    // 没有 id 就没有同步锚点，跳过（不编造 key）
    if (!record || !modelKey) continue
    models.push({ modelKey, raw: record })
  }
  return { endpoint, models }
}

// ─────────────────────────── Anthropic ───────────────────────────

/** Anthropic：`GET {base}/models?limit=1000`，`x-api-key` + `anthropic-version`，按 `has_more` + `last_id` 翻页 */
const listAnthropicModels = async (
  input: ListProviderModelsInput,
  timeoutMs: number,
): Promise<ListProviderModelsResult> => {
  const baseUrl = resolveBaseUrl(input.kind, input.baseUrl)
  const models: RemoteModel[] = []
  let endpoint = endpointOf(baseUrl, '/models', new URLSearchParams({ limit: '1000' }))
  let afterId: string | undefined

  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ limit: '1000' })
    if (afterId) query.set('after_id', afterId)
    endpoint = endpointOf(baseUrl, '/models', query)
    const body = await getJson(
      endpoint,
      {
        headers: {
          'x-api-key': input.apiKey,
          'anthropic-version': '2023-06-01',
          accept: 'application/json',
        },
      },
      timeoutMs,
    )

    for (const item of asArray(body.data)) {
      const record = asRecord(item)
      const modelKey = record ? asString(record.id) : undefined
      if (!record || !modelKey) continue
      models.push({ modelKey, displayName: asString(record.display_name), raw: record })
    }

    const lastId = asString(body.last_id)
    if (body.has_more !== true || !lastId) break
    afterId = lastId
  }
  return { endpoint, models }
}

// ─────────────────────────── Google Gemini ───────────────────────────

/** Gemini：`GET {base}/models?key=<key>&pageSize=1000`，取 `models[]`，按 `nextPageToken` 翻页 */
const listGoogleModels = async (
  input: ListProviderModelsInput,
  timeoutMs: number,
): Promise<ListProviderModelsResult> => {
  const baseUrl = resolveBaseUrl(input.kind, input.baseUrl)
  const models: RemoteModel[] = []
  let endpoint = ''
  let pageToken: string | undefined

  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ key: input.apiKey, pageSize: '1000' })
    if (pageToken) query.set('pageToken', pageToken)
    endpoint = endpointOf(baseUrl, '/models', query)
    const body = await getJson(endpoint, { headers: { accept: 'application/json' } }, timeoutMs)

    for (const item of asArray(body.models)) {
      const record = asRecord(item)
      const name = record ? asString(record.name) : undefined
      if (!record || !name) continue
      // `models/gemini-2.5-pro` → `gemini-2.5-pro`（存库口径与其它供应商一致）
      const modelKey = name.startsWith('models/') ? name.slice('models/'.length) : name
      const methods = asArray(record.supportedGenerationMethods).filter(
        (method): method is string => typeof method === 'string',
      )
      models.push({
        modelKey,
        displayName: asString(record.displayName),
        contextWindow: toPositiveInt(record.inputTokenLimit),
        maxOutputTokens: toPositiveInt(record.outputTokenLimit),
        // 能力标记：供应商给什么存什么（这里就是"支持哪些生成方法"），不额外推断
        ...(methods.length > 0 ? { capabilities: { methods } } : {}),
        raw: record,
      })
    }

    const next = asString(body.nextPageToken)
    if (!next) break
    pageToken = next
  }
  return { endpoint, models }
}

/** kind → adapter 的分派表（新增一家供应商只改这里） */
const ADAPTERS: Record<
  string,
  (input: ListProviderModelsInput, timeoutMs: number) => Promise<ListProviderModelsResult>
> = {
  [AiProviderKind.Openai]: listOpenAiModels,
  [AiProviderKind.OpenaiCompatible]: listOpenAiModels,
  [AiProviderKind.Anthropic]: listAnthropicModels,
  [AiProviderKind.Google]: listGoogleModels,
}

/**
 * 按 `kind` 拉取供应商的模型清单（唯一入口）。
 *
 * 失败一律抛 {@link ModelSyncFailedError}（3403），message 里带供应商原文与地址。
 */
export const listProviderModels = async (
  input: ListProviderModelsInput,
): Promise<ListProviderModelsResult> => {
  const adapter = ADAPTERS[input.kind]
  if (!adapter) {
    throw new ModelSyncFailedError(`不支持的供应商类型：${input.kind}`)
  }
  return adapter(input, input.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS)
}
