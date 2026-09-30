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
 * 收录范围：**国内厂商**（名单与默认地址、是否支持 `GET {base}/models` 见
 * `apps/server/src/modules/ai-model/provider-adapters.ts` 的 `PROVIDER_ENDPOINTS` 表）。
 * 刻意**不含 OpenAI / Anthropic / Google** 三家海外厂商。
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
  OpenaiCompatible: { label: 'OpenAI 兼容（自建网关/其它）', value: 'openai-compatible' },
})

/** 模型的来源：同步拉回来的 vs 手工补的（手工的同步时不覆盖，见 §4.8.3） */
export const AiModelSource = createDict({
  Sync: { label: '同步', value: 'sync' },
  Manual: { label: '手工', value: 'manual' },
})
