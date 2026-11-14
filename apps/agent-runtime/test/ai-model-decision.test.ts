import { describe, expect, it } from 'vitest'
import { AiProviderKind } from '@repo/shared'
import { decideModelForMastra } from '../src/modules/ai/core/model-decision.js'
import { OFFICIAL_ADAPTER_KINDS, usesOfficialAdapter } from '../src/modules/ai-model/index.js'
import type { RuntimeModel } from '../src/modules/ai/core/envelope.js'

/**
 * 「这一轮用哪个模型」的决策回归（**纯函数，不需要数据库 / 网络**）。
 *
 * 锁的是两个踩过的坑（用户在会话页看到的现象分别是"思考不显示"与"回答出来了但运行失败"）：
 * 1. 官方适配（DeepSeek）**绝不能传 `url`** —— 传了就走通用 OpenAI 兼容层，
 *    `reasoning_content` 整段被丢（前端自然没有思考可显示）；
 * 2. 判据必须是**供应商类型**（`ai_providers.kind`），不是 `modelRef` 的 slug 前缀 ——
 *    种子供应商的 slug 是 `env-default`，靠 slug 判断会让官方适配永远不生效。
 */

/** 造一个"这一轮解析出来的模型" */
const runtimeModel = (partial: Partial<RuntimeModel> = {}): RuntimeModel => ({
  id: 'model_1',
  modelRef: 'env-default/deepseek-flash',
  modelKey: 'deepseek-flash',
  displayName: 'deepseek-flash',
  providerKind: AiProviderKind.Deepseek,
  apiKey: 'sk-test',
  contextWindow: null,
  ...partial,
})

describe('模型决策：官方适配 vs 通用 OpenAI 兼容', () => {
  it('名单只有 DeepSeek（其余一律走通用兼容）', () => {
    expect(usesOfficialAdapter(AiProviderKind.Deepseek)).toBe(true)
    expect(OFFICIAL_ADAPTER_KINDS.has(AiProviderKind.Deepseek)).toBe(true)
    for (const kind of [
      AiProviderKind.OpenaiCompatible,
      AiProviderKind.Dashscope,
      AiProviderKind.Zhipu,
      AiProviderKind.Moonshot,
    ]) {
      expect(usesOfficialAdapter(kind)).toBe(false)
    }
    // 没值（历史数据 / 手工构造）时按"通用兼容"处理，不炸
    expect(usesOfficialAdapter(undefined)).toBe(false)
    expect(usesOfficialAdapter(null)).toBe(false)
  })

  it('官方适配：即使配了 baseURL 也不传 url（否则思考字段会被通用层丢掉）', () => {
    const decision = decideModelForMastra(runtimeModel({ baseURL: 'https://api.deepseek.com' }))
    expect(decision.officialAdapter).toBe(true)
    expect(decision.model.id).toBe('env-default/deepseek-flash')
    expect(decision.model.url).toBeUndefined()
    // 被忽略的地址要显式回报，调用方据此记 warn（不静默吞掉用户的配置）
    expect(decision.ignoredBaseURL).toBe('https://api.deepseek.com')
  })

  it('官方适配 + 没配 baseURL：同样不传 url，且没有"被忽略"可报', () => {
    const decision = decideModelForMastra(runtimeModel())
    expect(decision.model.url).toBeUndefined()
    expect(decision.ignoredBaseURL).toBeUndefined()
  })

  it('判据是 kind 不是 slug：slug 被改成任意值，官方适配照样生效', () => {
    const decision = decideModelForMastra(
      runtimeModel({ modelRef: 'whatever/renamed', baseURL: 'https://api.deepseek.com' }),
    )
    expect(decision.officialAdapter).toBe(true)
    expect(decision.model.url).toBeUndefined()
  })

  it('通用兼容：配了 baseURL 就必须传 url（自建网关 / 代理只能靠它）', () => {
    const decision = decideModelForMastra(
      runtimeModel({
        providerKind: AiProviderKind.OpenaiCompatible,
        modelRef: 'my-gateway/deepseek-flash',
        baseURL: 'http://127.0.0.1:1234/v1',
      }),
    )
    expect(decision.officialAdapter).toBe(false)
    expect(decision.model.url).toBe('http://127.0.0.1:1234/v1')
  })

  it('通用兼容 + 没配 baseURL：交给 provider 自己的默认端点（不塞 undefined）', () => {
    const decision = decideModelForMastra(
      runtimeModel({ providerKind: AiProviderKind.Moonshot, modelRef: 'moonshot/kimi-k2' }),
    )
    expect(decision.model.url).toBeUndefined()
    expect('url' in decision.model).toBe(false)
  })

  it('模型标识必须是 provider/model 形态（漏了斜杠在装配期就报错，不拖到第一次对话）', () => {
    expect(() => decideModelForMastra(runtimeModel({ modelRef: 'deepseek-flash' }))).toThrow(
      /provider\/model/,
    )
  })
})
