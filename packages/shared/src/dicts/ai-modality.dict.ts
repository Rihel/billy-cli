import { createDict } from '../utils'

/**
 * 模型能力的**独立字段**（对齐业界做法，不再塞进 `capabilities` 那个"供应商原始字段"的 jsonb）。
 *
 * ## 为什么要有这份
 *
 * `ai_models.capabilities` 的语义是"**供应商给什么存什么**"，同步会整列覆盖。
 * 而"这个模型能不能收图"是运行时**必须能查到**的事实（收不了就要当场拦下，否则上游会静默忽略，
 * 用户以为模型看过了）。把它塞进那种字段的结果是：同步时得写代码特判保住、前端要猜字段名、
 * 语义上也不对（它不是供应商的原始数据，是我们的模型画像）。
 *
 * ## 对齐哪一家
 *
 * **输入 / 输出模态数组**取自 OpenRouter 的 Models API 标准
 * （`architecture.input_modalities` / `output_modalities`，实测 465 个模型的取值就是
 * `text` / `image` / `file` / `audio` / `video`，见 `https://openrouter.ai/docs/guides/overview/models`）。
 * 好处是加一种新模态**不用改表**，而且与业界对外口径一致（将来要对接 OpenRouter 或导出模型清单，
 * 字段直接对得上）。
 *
 * **类型字段**（`mode`）取自 LiteLLM 的 `model_prices_and_context_window.json`
 * （4485 条里 4476 条都有 `mode`，取值 chat / embedding / image_generation / …）——
 * 没有它，选模型的下拉里会出现 embedding 模型，选中必然报错。
 */

/** 模态标记在字典里的键名与数组里的取值同名，便于直接消费 */
export const AiModality = createDict({
  Text: { label: '文本', value: 'text' },
  Image: { label: '图片', value: 'image' },
  File: { label: '文件', value: 'file' },
  Audio: { label: '音频', value: 'audio' },
  Video: { label: '视频', value: 'video' },
})

/** 认识的模态取值（不认识的过滤掉：别让脏数据污染"能不能收图"的判断） */
export const AI_MODALITIES = ['text', 'image', 'file', 'audio', 'video'] as const

export type AiModalityValue = (typeof AI_MODALITIES)[number]

/**
 * 模型类型（对齐 LiteLLM 的 `mode`）。
 *
 * 我们只关心"是不是对话模型"：agent 的模型选择器**只该列对话类**，
 * embedding / rerank / 图像生成这些选中了必然报错。
 */
export const AiModelMode = createDict({
  Chat: { label: '对话', value: 'chat' },
  Embedding: { label: '向量（embedding）', value: 'embedding' },
  ImageGeneration: { label: '图像生成', value: 'image_generation' },
  Transcription: { label: '语音转写', value: 'transcription' },
  Speech: { label: '语音合成', value: 'speech' },
  Rerank: { label: '重排（rerank）', value: 'rerank' },
  Moderation: { label: '内容审核', value: 'moderation' },
  Completion: { label: '文本补全', value: 'completion' },
  Unknown: { label: '未声明', value: 'unknown' },
})

/** 模型类型取值白名单 */
export const AI_MODEL_MODES = [
  'chat',
  'embedding',
  'image_generation',
  'transcription',
  'speech',
  'rerank',
  'moderation',
  'completion',
  'unknown',
] as const

export type AiModelModeValue = (typeof AI_MODEL_MODES)[number]

/** 默认模型类型：库里的老数据与手工新增都按对话模型处理（这是本工程的主要用途） */
export const DEFAULT_MODEL_MODE: AiModelModeValue = 'chat'

/** 只有对话（含文本补全）模型能进 agent 的模型选择器 */
export const CHAT_CAPABLE_MODES: readonly AiModelModeValue[] = ['chat', 'completion']

/**
 * 把任意来源的数组归一成模态清单。
 *
 * - 非数组 / 元素不是字符串 → 当作**未声明**（`null`），不编造；
 * - 认识的取值保留、去重、按 {@link AI_MODALITIES} 的顺序排（稳定输出，便于比对与展示）；
 * - **空数组是"明确声明不支持任何模态"**（与 `null` 的"未声明"是两件事，见 `AiModelEntity` 注释）。
 */
export const normalizeModalities = (value: unknown): AiModalityValue[] | null => {
  if (!Array.isArray(value)) return null
  const hit = new Set<string>()
  for (const item of value) {
    if (typeof item === 'string' && (AI_MODALITIES as readonly string[]).includes(item.toLowerCase())) {
      hit.add(item.toLowerCase())
    }
  }
  return AI_MODALITIES.filter((modality) => hit.has(modality)) as AiModalityValue[]
}

/**
 * 把任意来源的类型取值归一（**不认识一律 `unknown`**，不编造）。
 *
 * ⚠️ 与"库里新行的默认类型"是两件事：默认是 {@link DEFAULT_MODEL_MODE}（`chat`，
 * 因为本工程建的模型就是拿来对话的），而**解析供应商数据时**认不出必须落 `unknown` ——
 * 否则会在界面上声称"这是个对话模型"，而我们其实什么都没认出来。
 */
export const normalizeModelMode = (value: unknown): AiModelModeValue => {
  if (typeof value !== 'string') return 'unknown'
  const lower = value.trim().toLowerCase()
  return (AI_MODEL_MODES as readonly string[]).includes(lower) ? (lower as AiModelModeValue) : 'unknown'
}

/**
 * 模型能不能收某一类输入（附件校验用它）。
 *
 * 返回三态而不是布尔，因为"未声明"与"明确不支持"的处理完全不同：
 * - `null`（未声明）→ **不拦**，只提示（国内厂商普遍不给模态信息，硬拦会把视觉模型也误伤）；
 * - `false`（明确不支持）→ 拦下并说清；
 * - `true` → 放行。
 */
export const modalitySupport = (
  modalities: readonly string[] | null | undefined,
  modality: AiModalityValue,
): boolean | null => {
  if (!modalities) return null
  return modalities.includes(modality)
}
