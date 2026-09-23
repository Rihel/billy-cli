import { createDict } from '../utils'

/**
 * AI 模型模块的字典：供应商类型与模型来源。
 *
 * 术语：**供应商（provider）** = 一家模型服务（OpenAI / DeepSeek / 自建网关…）；
 * **模型（model）** = 该供应商下的一个可调用模型（`model_key` 是它在该供应商侧的 id）。
 */

/**
 * 供应商类型 —— **决定用哪个"列模型"接口去拉明细**（见设计文档 §4.8.2）。
 *
 * `openai-compatible` 是本工程的主力（DeepSeek / 阿里百炼兼容模式 / vLLM / One-API / 自建网关
 * 都是 OpenAI 形态），所以它不是"特殊分支"而是默认值。
 */
export const AiProviderKind = createDict({
  OpenaiCompatible: { label: 'OpenAI 兼容', value: 'openai-compatible' },
  Openai: { label: 'OpenAI 官方', value: 'openai' },
  Anthropic: { label: 'Anthropic', value: 'anthropic' },
  Google: { label: 'Google Gemini', value: 'google' },
})

/** 模型的来源：同步拉回来的 vs 手工补的（手工的同步时不覆盖，见 §4.8.3） */
export const AiModelSource = createDict({
  Sync: { label: '同步', value: 'sync' },
  Manual: { label: '手工', value: 'manual' },
})
