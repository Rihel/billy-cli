import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AiProviderKind } from '@repo/shared'
import { listProviderModels } from '../src/modules/ai-model/provider-adapters.js'

/**
 * "列模型"适配层对**规格字段**（展示名 / 上下文窗口 / 输出上限 / 能力标记）的解析。
 *
 * 为什么值得单独钉住：**上下文窗口是上下文裁剪与压缩策略的唯一输入**
 * （`ai/runtime/context.service.ts` 拿它算触发线）。供应商给了却没解析出来，
 * 表现不是报错，而是**静默退回 32K 兜底窗口并打一条 warn** ——
 * 于是长会话会过早触发裁剪，很难往"模型列表没同步到窗口"上想。
 *
 * DeepSeek 官方 `/models` 的 schema 明确包含 `name` / `context_window` /
 * `max_output_tokens` / `input_modalities` / `output_modalities` / `effort`，
 * 早期版本只有 `id` / `object` / `owned_by`。这里按官方 schema 与各家别名分别钉住。
 */

let server: Server
let baseUrl = ''
/** 每个用例前换一份响应体 */
let payload: unknown = { object: 'list', data: [] }

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock server 没起来')
  baseUrl = `http://127.0.0.1:${address.port}/v1`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const parseOne = async (record: Record<string, unknown>) => {
  payload = { object: 'list', data: [record] }
  const result = await listProviderModels({
    kind: AiProviderKind.OpenaiCompatible,
    baseUrl,
    apiKey: 'sk-test',
  })
  return result.models[0]
}

describe('规格字段解析（各家形态）', () => {
  it('DeepSeek 官方形态：name / context_window / max_output_tokens / 模态 / effort', async () => {
    const model = await parseOne({
      id: 'deepseek-chat',
      object: 'model',
      owned_by: 'deepseek',
      name: 'DeepSeek V3',
      context_window: 131_072,
      max_output_tokens: 8_192,
      input_modalities: ['text'],
      output_modalities: ['text'],
      effort: { supported_levels: ['low', 'high'], default_level: 'high' },
    })
    expect(model.displayName).toBe('DeepSeek V3')
    expect(model.contextWindow).toBe(131_072)
    expect(model.maxOutputTokens).toBe(8_192)
    expect(model.inputModalities).toEqual(['text'])
    expect(model.outputModalities).toEqual(['text'])
    // 没有顶层 capabilities 时，effort 也要留住（它是运行时 reasoning_effort 的取值来源）
    expect(model.capabilities?.effort).toEqual({
      supported_levels: ['low', 'high'],
      default_level: 'high',
    })
  })

  it('Moonshot 形态：context_length 是窗口的别名', async () => {
    const model = await parseOne({ id: 'moonshot-v1-128k', context_length: 128_000 })
    expect(model.contextWindow).toBe(128_000)
  })

  it('自建网关 / vLLM 形态：max_model_len', async () => {
    const model = await parseOne({ id: 'Qwen2.5-72B', max_model_len: 32_768 })
    expect(model.contextWindow).toBe(32_768)
  })

  it('字符串数字也认（部分自建清单把窗口写成 "32768"）', async () => {
    const model = await parseOne({ id: 'glm-4', context_window: '128000' })
    expect(model.contextWindow).toBe(128_000)
  })

  it('嵌套声明（limits.context_length）也能取到', async () => {
    const model = await parseOne({ id: 'x', limits: { context_length: 65_536 } })
    expect(model.contextWindow).toBe(65_536)
  })

  it('什么都不给 → 全 undefined（不编造，落库为 null）', async () => {
    const model = await parseOne({ id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' })
    expect(model.contextWindow).toBeUndefined()
    expect(model.maxOutputTokens).toBeUndefined()
    expect(model.displayName).toBeUndefined()
    expect(model.capabilities).toBeUndefined()
  })

  it('不把裸 max_tokens 当输出上限（OpenAI 形态里它是请求默认值）', async () => {
    const model = await parseOne({ id: 'x', max_tokens: 4_096 })
    expect(model.maxOutputTokens).toBeUndefined()
  })

  it('0 / 负数 / 小数不算窗口（宁可当没给）', async () => {
    const model = await parseOne({ id: 'x', context_window: 0, max_output_tokens: -1 })
    expect(model.contextWindow).toBeUndefined()
    expect(model.maxOutputTokens).toBeUndefined()
  })

  it('capabilities 是数组时包一层存，不直接塞进 jsonb', async () => {
    const model = await parseOne({ id: 'x', capabilities: ['vision', 'tools'] })
    expect(model.capabilities).toEqual({ list: ['vision', 'tools'] })
  })
})
