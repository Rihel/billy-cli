import { describe, expect, it } from 'vitest'
import { buildOpenAiRequest } from '../src/protocols/types.js'
import { entryOf, targetOf } from './helpers.js'

describe('OpenAI 兼容适配器', () => {
  it('拼出 {base}/chat/completions，替换 model 为供应商 modelKey，并注入 Bearer', () => {
    const target = targetOf({
      entry: entryOf({
        providerKind: 'moonshot',
        protocol: 'openai-compatible',
        providerSlug: 'kimi',
        modelKey: 'kimi-k2',
      }),
      apiKey: 'sk-test',
      baseUrl: 'https://api.moonshot.cn/v1',
    })
    const request = buildOpenAiRequest({
      body: { messages: [{ role: 'user', content: 'hi' }] },
      target,
    })
    expect(request.url).toBe('https://api.moonshot.cn/v1/chat/completions')
    expect(request.headers.authorization).toBe('Bearer sk-test')
    expect((request.body as Record<string, unknown>).model).toBe('kimi-k2')
  })

  it('baseUrl 缺省时回落到 kind 的官方画像', () => {
    const target = targetOf({
      entry: entryOf({ providerKind: 'deepseek', protocol: 'deepseek', providerSlug: 'ds' }),
      apiKey: 'sk-ds',
      baseUrl: null,
    })
    const request = buildOpenAiRequest({
      body: { messages: [{ role: 'user', content: 'hi' }] },
      target,
    })
    expect(request.url).toBe('https://api.deepseek.com/chat/completions')
  })

  it('缺密钥直接报错，不把空串发给上游', () => {
    const target = targetOf({
      entry: entryOf({ providerKind: 'moonshot', providerSlug: 'kimi' }),
      apiKey: null,
      baseUrl: 'https://example.com/v1',
    })
    expect(() => buildOpenAiRequest({ body: { messages: [] }, target })).toThrowError(/未配置密钥/)
  })
})
