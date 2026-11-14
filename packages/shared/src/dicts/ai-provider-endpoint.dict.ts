import { AiProviderKind, AiProviderProtocol } from './ai-model.dict'

/** 鉴权方式：Bearer（多数 OpenAI 兼容）/ x-api-key（Anthropic）/ 无（Ollama） */
export type ProviderAuthStyle = 'bearer' | 'x-api-key' | 'none'

/** 一家供应商的接入画像（**新增一家供应商只改这张表**） */
export interface ProviderEndpointProfile {
  /**
   * 官方默认 baseURL（`GET {baseUrl}{modelsPath}` 就是"列模型"地址）。
   *
   * **必须包含兼容路径**：百炼要带 `/compatible-mode/v1`，火山方舟用 `/api/v3`，
   * 智谱用 `/api/paas/v4` —— 这些都不是 `/v1`。
   */
  baseUrl: string
  /** 该家是否提供"列模型"接口；`false` 时同步直接给中文提示，不发必然失败的请求 */
  supportsModelList: boolean
  /** 该家的特别之处（一句话，中文，供选型与排障） */
  note: string
  /** 对话请求路径（相对 `baseUrl`）；缺省 `/chat/completions` */
  chatPath?: string
  /** 鉴权方式；缺省 `bearer` */
  authStyle?: ProviderAuthStyle
}

/**
 * **kind → 接入画像**（默认地址表）。
 *
 * 证据分级（详见调研报告）：官方文档 > 实测探测（无密钥打 `GET {base}/models`，
 * 401/403 + 路径正确 说明路由存在）> 第三方开源项目旁证。逐家说明写在各行 `note` 里。
 */
export const PROVIDER_ENDPOINTS: Record<string, ProviderEndpointProfile> = {
  [AiProviderKind.Deepseek]: {
    baseUrl: 'https://api.deepseek.com',
    supportsModelList: true,
    note: '官方文档 base_url 就是 https://api.deepseek.com（不带 /v1）；GET /models 的 data[] 除 id / object / owned_by，还带 name / context_window / max_output_tokens / input_modalities / output_modalities / effort（窗口与输出上限就靠它，早期版本只返回前三个字段）。',
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
  [AiProviderKind.Anthropic]: {
    baseUrl: 'https://api.anthropic.com',
    supportsModelList: true,
    note: 'Claude Messages API：POST /v1/messages，鉴权 x-api-key + anthropic-version；流式是 SSE 事件流（message_start / content_block_delta / message_delta / message_stop），需要协议转换。',
    chatPath: '/v1/messages',
    authStyle: 'x-api-key',
  },
  [AiProviderKind.Ollama]: {
    baseUrl: 'http://127.0.0.1:11434',
    supportsModelList: true,
    note: 'Ollama 原生：POST /api/chat，流式是 NDJSON（每行一个 JSON，不是 SSE）；模型列表走 /api/tags，窗口走 /api/show；默认无鉴权。',
    chatPath: '/api/chat',
    authStyle: 'none',
  },
  [AiProviderKind.OpenaiCompatible]: {
    baseUrl: '',
    supportsModelList: true,
    note: '自建网关 / One-API / vLLM 等其它 OpenAI 兼容服务：协议形态统一，但没有官方的"某一家"地址，baseUrl 必须由使用者显式填写。',
  },
}

/**
 * kind → protocol。
 *
 * 目前只有 DeepSeek / Anthropic / Ollama 需要专属协议；其余（含自建）都按 OpenAI 兼容处理。
 * 加一家 OpenAI 兼容厂商**不要**动这里，只在 `PROVIDER_ENDPOINTS` 加画像。
 */
export const KIND_PROTOCOLS: Record<string, string> = {
  [AiProviderKind.Deepseek]: AiProviderProtocol.Deepseek,
  [AiProviderKind.Anthropic]: AiProviderProtocol.Anthropic,
  [AiProviderKind.Ollama]: AiProviderProtocol.Ollama,
}

export const protocolOfKind = (kind: string | null | undefined): string =>
  (kind && KIND_PROTOCOLS[kind]) || AiProviderProtocol.OpenaiCompatible

/** 对话请求路径（相对 baseUrl） */
export const chatPathOf = (kind: string | null | undefined): string =>
  (kind && PROVIDER_ENDPOINTS[kind]?.chatPath) || '/chat/completions'

/** 鉴权方式 */
export const authStyleOf = (kind: string | null | undefined): ProviderAuthStyle =>
  (kind && PROVIDER_ENDPOINTS[kind]?.authStyle) || 'bearer'
