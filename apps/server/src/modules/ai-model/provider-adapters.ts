import { AiProviderKind } from '@repo/shared'
import { ModelSyncFailedError } from './errors.js'

/**
 * "列模型"适配层（**纯函数 + 一次 fetch，可脱离数据库单测**）。
 *
 * 收录范围：**国内厂商**（不含 OpenAI / Anthropic / Google）。这些厂商都对外提供
 * OpenAI 形态的 `GET {base}/models`（`Authorization: Bearer`，响应 `{ object: 'list', data: [...] }`），
 * 所以本层**只有一个通用 OpenAI 兼容 adapter** —— 厂商之间的差别**只落在默认 baseURL 上**，
 * 统一登记在 {@link PROVIDER_ENDPOINTS}（新增一家 = 表里加一行）。
 *
 * 三条硬口径：
 * - **容错解析**：字段缺失不报错（拿不到就是 `undefined`），但**绝不编造** ——
 *   拿不到上下文窗口就是 `null`，不猜一个"看起来合理"的数；
 * - **非 2xx 带原文**：错误信息里带响应体前 300 字符（排障要看供应商原话）；
 * - **超时**：`AbortSignal.timeout`，默认 15s，避免一个卡死的网关把同步拖到天荒地老。
 *
 * 翻页口径：OpenAI 形态**通常一次返回全部**，这里只为"永远为真的 has_more"留一个
 * **最多 {@link MAX_PAGES} 页**的兜底（同一个 modelKey 只收一次）。
 */

/** 供应商侧的一个模型（解析后的统一形态） */
export interface RemoteModel {
  /** 供应商侧的模型 id（`data[].id`；这是同步的幂等锚点） */
  modelKey: string
  /** 展示名（OpenAI 形态不返回展示名，留空则由上层回落 `modelKey`） */
  displayName?: string
  /** 上下文窗口（OpenAI 形态不返回，拿不到就是 undefined） */
  contextWindow?: number
  /** 单次输出上限（OpenAI 形态不返回，拿不到就是 undefined） */
  maxOutputTokens?: number
  /** 能力标记；拿不到就是 undefined */
  capabilities?: Record<string, unknown>
  /** 供应商原始 JSON（**全量留存、不裁剪**，原样进 `ai_models.raw`） */
  raw: Record<string, unknown>
}

export interface ListProviderModelsInput {
  /** 供应商类型（见 `AiProviderKind` 字典） */
  kind: string
  /** 接口地址；留空用该 kind 的默认地址（`openai-compatible` 没有默认，必须配） */
  baseUrl?: string | null
  /** 供应商密钥明文（只在内存里流转） */
  apiKey: string
  /** 超时（ms）；默认 15s */
  timeoutMs?: number
}

export interface ListProviderModelsResult {
  /** 实际请求的最后一个地址（排障第一步：确认打到了哪） */
  endpoint: string
  models: RemoteModel[]
}

/** 一家供应商的接入画像（**新增一家供应商只改这张表**） */
export interface ProviderEndpointProfile {
  /**
   * 官方默认 baseURL（`GET {baseUrl}/models` 就是"列模型"地址）。
   *
   * **必须包含兼容路径**：百炼要带 `/compatible-mode/v1`，火山方舟用 `/api/v3`，
   * 智谱用 `/api/paas/v4` —— 这些都不是 `/v1`。
   */
  baseUrl: string
  /** 该家是否提供 OpenAI 形态的"列模型"接口；`false` 时同步直接给中文提示，不发必然失败的请求 */
  supportsModelList: boolean
  /** 该家的特别之处（一句话，中文，供选型与排障） */
  note: string
}

/**
 * **kind → 接入画像**（默认地址表）。
 *
 * 证据分级（详见本次调研报告）：官方文档 > 实测探测（无密钥打 `GET {base}/models`，
 * 401/403 + 路径正确 说明路由存在）> 第三方开源项目旁证。逐家说明写在各行 `note` 里。
 */
export const PROVIDER_ENDPOINTS: Record<string, ProviderEndpointProfile> = {
  [AiProviderKind.Deepseek]: {
    baseUrl: 'https://api.deepseek.com',
    supportsModelList: true,
    note: '官方文档 base_url 就是 https://api.deepseek.com（不带 /v1）；GET /models 返回 data[]（id / object / owned_by）。',
  },
  [AiProviderKind.Dashscope]: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    supportsModelList: true,
    note: '阿里云百炼必须走兼容模式 /compatible-mode/v1；百炼自有的 /api/v1/models 是另一套形态（output.models[] + page_no 分页），不是 OpenAI 形态，别混用。',
  },
  [AiProviderKind.Zhipu]: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    supportsModelList: true,
    note: '智谱兼容路径是 /api/paas/v4（不是 /v1）；/models 实测返回 401 鉴权错误、第三方 new-api 也在用，但官方 OpenAI 兼容文档未单列该接口。',
  },
  [AiProviderKind.Moonshot]: {
    baseUrl: 'https://api.moonshot.cn/v1',
    supportsModelList: true,
    note: '月之暗面/Kimi 官方文档明确 GET /v1/models，data[] 除 id/created/owned_by 还带 context_length 等能力位（原样进 raw）。',
  },
  [AiProviderKind.Volcengine]: {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    supportsModelList: true,
    note: '火山方舟兼容路径是 /api/v3（用 /v1 会 404）；GET /api/v3/models 是官方 OpenAI 形态（data[] 的 id / owned_by），但随账户/套餐可见的模型可能不全，拉不全时手工新增。',
  },
  [AiProviderKind.Siliconflow]: {
    baseUrl: 'https://api.siliconflow.cn/v1',
    supportsModelList: true,
    note: '硅基流动用标准 /v1；官方 API 文档有 GET /v1/models 的 cURL 示例。',
  },
  [AiProviderKind.Minimax]: {
    baseUrl: 'https://api.minimaxi.com/v1',
    supportsModelList: true,
    note: 'MiniMax 国内域名 api.minimaxi.com（旧域名 api.minimax.chat 也可用）；官方文档给出 GET /v1/models 的 OpenAI 形态示例。',
  },
  [AiProviderKind.Qianfan]: {
    baseUrl: 'https://qianfan.baidubce.com/v2',
    supportsModelList: true,
    note: '百度千帆 v2 是 OpenAI 兼容路径；实测 GET /v2/models 返回 403（无密钥 AccessDenied）而随机路径返回 404，说明路由存在。',
  },
  [AiProviderKind.Hunyuan]: {
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    supportsModelList: true,
    note: '腾讯混元 OpenAI 兼容端点为 /v1，返回的是 OpenAI 形态 401 错误（随机路径 404），说明路由存在。',
  },
  [AiProviderKind.Stepfun]: {
    baseUrl: 'https://api.stepfun.com/v1',
    supportsModelList: true,
    note: '阶跃星辰官方文档明确 GET https://api.stepfun.com/v1/models，返回 data[]（id / object / created / owned_by）。',
  },
  [AiProviderKind.Spark]: {
    baseUrl: 'https://spark-api-open.xf-yun.com/v1',
    supportsModelList: false,
    note: '讯飞星火官方 HTTP 文档只提供 POST /v1/chat/completions，**未提供列模型接口**（该网关对所有路径都先鉴权，/models 探测无区分度），因此只能手工新增模型。',
  },
  [AiProviderKind.OpenaiCompatible]: {
    baseUrl: '',
    supportsModelList: true,
    note: '自建网关 / One-API / vLLM 等其它 OpenAI 兼容服务：协议形态统一，但没有官方的"某一家"地址，baseUrl 必须由使用者显式填写。',
  },
}

/**
 * 有**官方 SDK 适配**的供应商类型（这些必须交给 `@ai-sdk/<provider>`，才能拿到各家私有字段）。
 *
 * 最典型的是**思考**：DeepSeek 的 `reasoning_content` 通用 OpenAI 兼容层不认，
 * 整段思考会被丢掉（踩过：前端"思考没显示"的根因之一）。
 *
 * 与 {@link PROVIDER_ENDPOINTS} 的区别（两者别混）：
 * - `PROVIDER_ENDPOINTS` 管的是「**列模型**怎么拉」（`GET {base}/models` 的形态与默认地址）；
 * - 本表管的是「**跑对话**用哪个 SDK」。两者有意分开：一家可能有官方 SDK 但列模型走通用形态。
 *
 * 加一家 = 装上它的 `@ai-sdk/<provider>`（版本要匹配 `ai@6`，即 provider 规范 v2）并把 `kind` 写进来。
 */
export const OFFICIAL_ADAPTER_KINDS: ReadonlySet<string> = new Set([AiProviderKind.Deepseek])

/**
 * 这一家是否走官方 SDK 适配（运行时判断的**唯一入口**）。
 *
 * 用 `ai_providers.kind` 而不是 `modelRef` 的前缀（slug）：slug 是展示用的、人能改、还能撞名，
 * 靠它判断会让"官方适配"在改个 slug 之后就静默失效（踩过），而 `kind` 是配置里的语义字段。
 */
export const usesOfficialAdapter = (kind: string | null | undefined): boolean =>
  kind ? OFFICIAL_ADAPTER_KINDS.has(kind) : false

/**
 * 各 kind 的默认地址（**扁平派生表**，`kind → baseUrl`）。
 *
 * 供只需要地址、不关心其它画像的调用方使用；没有官方默认的 kind（`openai-compatible`）不在表里。
 */
export const DEFAULT_PROVIDER_BASE_URLS: Record<string, string> = Object.fromEntries(
  Object.entries(PROVIDER_ENDPOINTS)
    .filter(([, profile]) => profile.baseUrl.length > 0)
    .map(([kind, profile]) => [kind, profile.baseUrl]),
)

/** 默认超时（ms） */
export const DEFAULT_SYNC_TIMEOUT_MS = 15_000
/** 翻页上限（OpenAI 兼容形态通常一页到底，这里只是"has_more 永远为真"的死循环兜底） */
export const MAX_PAGES = 10
/** 非 2xx 时带进错误信息的响应体长度上限 */
const ERROR_BODY_MAX = 300

/** 去掉末尾斜杠（避免拼出 `//models`） */
const trimSlash = (value: string): string => value.replace(/\/+$/, '')

/** 解析基地址：显式配置优先，否则回落该 kind 的官方默认 */
const resolveBaseUrl = (
  kind: string,
  profile: ProviderEndpointProfile,
  baseUrl?: string | null,
): string => {
  const configured = baseUrl?.trim()
  if (configured) return trimSlash(configured)
  if (profile.baseUrl) return trimSlash(profile.baseUrl)
  throw new ModelSyncFailedError(
    `供应商类型「${kind}」没有官方默认地址，必须配置 baseUrl（如自建网关的 https://host/v1）`,
  )
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

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

// ─────────────────────────── 通用 OpenAI 兼容形态（全部国内厂商共用） ───────────────────────────

/**
 * OpenAI 形态：`GET {base}/models` + `Authorization: Bearer <key>`，
 * 取 `data[]` 的 `id`（同步锚点）；`created` / `owned_by` 等字段**原样留在 `raw`** 里。
 *
 * 百炼 / 智谱 / 火山方舟 / 硅基流动 / 千帆 / 混元 / 阶跃星辰 / MiniMax / Moonshot / DeepSeek
 * 都是同一个 adapter，差别只在 {@link PROVIDER_ENDPOINTS} 里的默认地址。
 */
const listOpenAiCompatibleModels = async (
  input: ListProviderModelsInput,
  profile: ProviderEndpointProfile,
  timeoutMs: number,
): Promise<ListProviderModelsResult> => {
  const baseUrl = resolveBaseUrl(input.kind, profile, input.baseUrl)
  const headers = {
    authorization: `Bearer ${input.apiKey}`,
    accept: 'application/json',
  }
  const models: RemoteModel[] = []
  const seen = new Set<string>()
  let endpoint = endpointOf(baseUrl, '/models')
  let after: string | undefined

  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams()
    if (after) query.set('after', after)
    endpoint = endpointOf(baseUrl, '/models', query)
    const body = await getJson(endpoint, { headers }, timeoutMs)

    let added = 0
    for (const item of asArray(body.data)) {
      const record = asRecord(item)
      const modelKey = record ? asString(record.id) : undefined
      // 没有 id 就没有同步锚点，跳过（不编造 key）
      if (!record || !modelKey || seen.has(modelKey)) continue
      seen.add(modelKey)
      models.push({ modelKey, raw: record })
      added += 1
    }

    // OpenAI 形态没有标准翻页；只有供应商明确给了 has_more + last_id 游标才继续
    const next = asString(body.last_id)
    if (body.has_more !== true || !next || added === 0) break
    after = next
  }
  return { endpoint, models }
}

/**
 * 按 `kind` 拉取供应商的模型清单（唯一入口）。
 *
 * 三种明确失败（都抛 {@link ModelSyncFailedError} 3403，message 里带供应商原文与地址）：
 * - kind 不在表里 → "不支持的供应商类型"；
 * - 该家没有 OpenAI 形态的列模型接口 → "该供应商不支持自动拉取模型明细，请手工新增模型"（**不发请求**）；
 * - 请求失败 / 非 2xx / 非 JSON → 带供应商原文与地址。
 */
export const listProviderModels = async (
  input: ListProviderModelsInput,
): Promise<ListProviderModelsResult> => {
  const profile = PROVIDER_ENDPOINTS[input.kind]
  if (!profile) {
    throw new ModelSyncFailedError(`不支持的供应商类型：${input.kind}`)
  }
  if (!profile.supportsModelList) {
    const label = AiProviderKind.getLabel(input.kind) ?? input.kind
    throw new ModelSyncFailedError(
      `该供应商不支持自动拉取模型明细，请手工新增模型（供应商类型：${label}）`,
    )
  }
  return listOpenAiCompatibleModels(input, profile, input.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS)
}
