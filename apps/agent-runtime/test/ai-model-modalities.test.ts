import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AiProviderKind } from '@repo/shared'
import { listProviderModels } from '../src/modules/ai-model/provider-adapters.js'

/**
 * "列模型"适配层对**模态与类型**的解析。
 *
 * 为什么值得单独钉住：各家"列模型"接口给的字段名完全不一样（这正是"供应商不一定告诉你它能不能收图"），
 * 而解析结果直接决定附件拦不拦。这里的每个响应对应一种真实存在过的形态；
 * 认不出必须落 `null`（未声明）而**不是编造**一个值。
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

describe('模态解析（各家形态）', () => {
  it('OpenRouter 形态：architecture.input_modalities / output_modalities', async () => {
    const model = await parseOne({
      id: 'google/gemini-2.5-pro',
      architecture: { input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] },
    })
    expect(model.inputModalities).toEqual(['text', 'image', 'file'])
    expect(model.outputModalities).toEqual(['text'])
  })

  it('LiteLLM 形态：supports_vision / supports_pdf_input 布尔位', async () => {
    const model = await parseOne({
      id: 'gpt-4o',
      supports_vision: true,
      supports_pdf_input: true,
    })
    expect(model.inputModalities).toEqual(['text', 'image', 'file'])
  })

  it('顶层直接给模态（部分自建网关这么写）', async () => {
    const model = await parseOne({ id: 'qwen-vl-max', input_modalities: ['text', 'image'] })
    expect(model.inputModalities).toEqual(['text', 'image'])
    // 没给输出 → 未声明，不编造
    expect(model.outputModalities).toBeNull()
  })

  it('`capabilities` 里的词也算证据（百炼 / 火山这类自建清单常见）', async () => {
    const model = await parseOne({ id: 'glm-4v', capabilities: ['vision'] })
    expect(model.inputModalities).toEqual(['text', 'image'])
  })

  it('**什么都不给 → 未声明（null）**，绝不编造成"只支持文本"', async () => {
    const model = await parseOne({ id: 'deepseek-chat' })
    expect(model.inputModalities).toBeNull()
    expect(model.outputModalities).toBeNull()
  })

  it('给了字段但取值都不认识 → 未声明（不猜）', async () => {
    const model = await parseOne({ id: 'x', input_modalities: ['hologram'] })
    expect(model.inputModalities).toBeNull()
  })

  it('模态去重、按固定顺序输出', async () => {
    const model = await parseOne({ id: 'x', input_modalities: ['image', 'text', 'image'] })
    expect(model.inputModalities).toEqual(['text', 'image'])
  })
})

describe('模型类型解析', () => {
  it('显式 `mode` 优先', async () => {
    expect((await parseOne({ id: 'x', mode: 'chat' })).mode).toBe('chat')
    expect((await parseOne({ id: 'x', mode: 'embedding' })).mode).toBe('embedding')
  })

  it('OpenRouter 的 `modality` 串描述的是**输入输出**，不是模型类型 → unknown', async () => {
    const model = await parseOne({
      id: 'x',
      architecture: { modality: 'text+image->text' },
    })
    // `text` / `image` 是模态词，不在类型白名单里；认不出就是 unknown（不硬塞成 chat）
    expect(model.mode).toBe('unknown')
    // 但模态本身要认出来 —— 同一份 architecture 里的 input_modalities 才是能力的来源
    expect(model.inputModalities).toBeNull()
  })

  it('**认不出就是 unknown**，不猜成对话模型', async () => {
    expect((await parseOne({ id: 'mystery-model' })).mode).toBe('unknown')
  })

  it('modelKey 带类型线索时按线索定（这是证据不是猜测）', async () => {
    expect((await parseOne({ id: 'text-embedding-3-small' })).mode).toBe('embedding')
    expect((await parseOne({ id: 'bge-m3' })).mode).toBe('embedding')
  })
})
