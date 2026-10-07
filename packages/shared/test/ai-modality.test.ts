import { describe, expect, it } from 'vitest'
import {
  AI_MODALITIES,
  AI_MODEL_MODES,
  CHAT_CAPABLE_MODES,
  DEFAULT_MODEL_MODE,
  modalitySupport,
  normalizeModalities,
  normalizeModelMode,
} from '../src/dicts/ai-modality.dict'

/**
 * 模型能力字段（类型 + 输入/输出模态）。
 *
 * 口径来自业界的两个范式：模态数组对齐 OpenRouter 的 `architecture.input_modalities`，
 * 类型字段对齐 LiteLLM 的 `mode`。这里钉住的是**归一规则**与**三态语义** ——
 * 后者最关键：`null`（未声明）与 `[]`（明确什么都不支持）绝不能被压成同一种。
 */

describe('normalizeModalities', () => {
  it('认识的取值保留，并按固定顺序输出（稳定，便于比对）', () => {
    expect(normalizeModalities(['image', 'text'])).toEqual(['text', 'image'])
    expect(normalizeModalities(['file', 'text', 'image'])).toEqual(['text', 'image', 'file'])
  })

  it('大写 / 重复 / 不认识的取值都归一', () => {
    expect(normalizeModalities(['TEXT', 'text', 'IMAGE', 'telepathy'])).toEqual(['text', 'image'])
  })

  it('**空数组与 null 是两件事**（明确不支持 vs 未声明）', () => {
    expect(normalizeModalities([])).toEqual([])
    expect(normalizeModalities(null)).toBeNull()
    expect(normalizeModalities(undefined)).toBeNull()
  })

  it('不是数组就当未声明（不编造）', () => {
    expect(normalizeModalities('image')).toBeNull()
    expect(normalizeModalities({ image: true })).toBeNull()
    expect(normalizeModalities(123)).toBeNull()
  })

  it('全部取值都不认识 → 空数组（供应商给了字段，但没有我们认识的值）', () => {
    expect(normalizeModalities(['hologram'])).toEqual([])
  })
})

describe('normalizeModelMode', () => {
  it('认识的类型保留', () => {
    expect(normalizeModelMode('chat')).toBe('chat')
    expect(normalizeModelMode('Embedding')).toBe('embedding')
  })

  it('不认识 / 缺失 → unknown（不编造类型）', () => {
    expect(normalizeModelMode('quantum')).toBe('unknown')
    expect(normalizeModelMode(undefined)).toBe('unknown')
    expect(normalizeModelMode(42)).toBe('unknown')
  })
})

describe('modalitySupport', () => {
  it('三态：未声明 / 明确支持 / 明确不支持', () => {
    expect(modalitySupport(null, 'image')).toBeNull()
    expect(modalitySupport(undefined, 'image')).toBeNull()
    expect(modalitySupport(['text', 'image'], 'image')).toBe(true)
    expect(modalitySupport(['text'], 'image')).toBe(false)
    expect(modalitySupport([], 'image')).toBe(false)
  })
})

describe('字典自身的约束', () => {
  it('对话类里包含 chat（这是本工程的主要用途）', () => {
    expect(CHAT_CAPABLE_MODES).toContain('chat')
    expect(DEFAULT_MODEL_MODE).toBe('chat')
  })

  it('模态与类型取值不重复、不为空', () => {
    expect(new Set(AI_MODALITIES).size).toBe(AI_MODALITIES.length)
    expect(new Set(AI_MODEL_MODES).size).toBe(AI_MODEL_MODES.length)
    expect(AI_MODALITIES).toContain('text')
  })
})
