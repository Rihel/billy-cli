import { createDict } from '../utils'

/**
 * AI 模型模块的字典：供应商类型与模型来源。
 *
 * 术语：**供应商（provider）** = 一家模型服务（DeepSeek / 阿里云百炼 / 自建网关…）；
 * **模型（model）** = 该供应商下的一个可调用模型（`model_key` 是它在该供应商侧的 id）。
 */

/**
 * 供应商类型 —— **决定用哪个"列模型"接口去拉明细**（见设计文档 §4.8.2）。
 *
 * 收录范围：国内厂商 + 两个**协议型**条目（`anthropic` / `ollama`）。
 * 名单、默认地址、对话路径与鉴权方式见同目录的 `ai-provider-endpoint.dict.ts`（`PROVIDER_ENDPOINTS`）。
 * 厂商的 `kind` 不决定协议，协议由 `protocolOfKind()` 推导（见 `AiProviderProtocol`）。
 *
 * `openai-compatible` 不是某一家厂商，而是**协议形态兜底**：自建网关 / One-API / vLLM 等
 * 其它 OpenAI 兼容服务都归到它（这类服务必须有官方默认之外的地址，baseUrl 留空会明确报错）。
 * 它同时是 `ai_providers.kind` 的列默认值与"环境变量种子"供应商的 kind。
 */
export const AiProviderKind = createDict({
  Deepseek: { label: 'DeepSeek 官方', value: 'deepseek' },
  Dashscope: { label: '阿里云百炼', value: 'dashscope' },
  Zhipu: { label: '智谱 AI（GLM）', value: 'zhipu' },
  Moonshot: { label: '月之暗面（Kimi）', value: 'moonshot' },
  Volcengine: { label: '字节火山方舟（豆包）', value: 'volcengine' },
  Siliconflow: { label: '硅基流动', value: 'siliconflow' },
  Minimax: { label: 'MiniMax', value: 'minimax' },
  Qianfan: { label: '百度千帆', value: 'qianfan' },
  Hunyuan: { label: '腾讯混元', value: 'hunyuan' },
  Stepfun: { label: '阶跃星辰', value: 'stepfun' },
  Spark: { label: '讯飞星火', value: 'spark' },
  Anthropic: { label: 'Anthropic（Claude）', value: 'anthropic' },
  Ollama: { label: 'Ollama（本地/自建）', value: 'ollama' },
  OpenaiCompatible: { label: 'OpenAI 兼容（自建网关/其它）', value: 'openai-compatible' },
})

/**
 * 供应商的**线路协议**（决定网关用哪个协议适配器，见 `docs/design/model-gateway.md` §3.7）。
 *
 * 与 `AiProviderKind` 分开：kind 是"哪一家"（展示、默认地址），protocol 是"说哪种话"
 * （OpenAI 兼容 / DeepSeek / Anthropic / Ollama）。加一家厂商通常不需要加协议。
 */
export const AiProviderProtocol = createDict({
  OpenaiCompatible: { label: 'OpenAI 兼容', value: 'openai-compatible' },
  Deepseek: { label: 'DeepSeek', value: 'deepseek' },
  Anthropic: { label: 'Anthropic Messages', value: 'anthropic' },
  Ollama: { label: 'Ollama 原生', value: 'ollama' },
})

/** 模型的来源：同步拉回来的 vs 手工补的（手工的同步时不覆盖，见 §4.8.3） */
export const AiModelSource = createDict({
  Sync: { label: '同步', value: 'sync' },
  Manual: { label: '手工', value: 'manual' },
})

/** 模型配置变更事件（main 写库后发，网关订阅失效目录/ key 缓存） */
export const AI_MODEL_CHANGED_TOPIC = 'ai.model.changed'
