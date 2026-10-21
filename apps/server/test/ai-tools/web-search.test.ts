import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  WebTools,
  type WebSearchOutput,
} from '../../src/modules/ai/tools/web.tools.js'
import { TOOL_KEYS } from '../../src/modules/ai/core/tools/tool-keys.js'
import { ToolDeniedError } from '../../src/modules/ai/core/tools/tools.types.js'
import {
  buildToolStackDeps,
  makeToolContext,
  silentLogger,
  specByKey,
} from '../helpers/ai-tool-stack.js'

/**
 * `web-search` 的单测：**本机起一个假的 DeepSeek 搜索接口**，不碰外网。
 *
 * 验五条最容易坏、坏了最难看的东西：
 * 1. **协议映射**：`need_content` / `ori_question` 真的发出去了，返回字段真的换成了我们的名字；
 * 2. **密钥**：显式配置优先，其次复用当前轮 DeepSeek 官方模型的密钥；两者都没有时 precheck 给结论；
 * 3. **正文截断**：`needContent` 打开时每条正文有上限，并标记 `contentTruncated`；
 * 4. **空结果**：不抛错，给"换关键词"的结论；
 * 5. **错误码**：401 / 402 / 429 各自翻成不同的 reason（模型据此决定改不改请求）。
 */

/** 假接口的返回模式（每个用例自己切） */
type Mode = 'ok' | 'empty' | '401' | '402' | '429' | '500'

const state = {
  mode: 'ok' as Mode,
  body: null as Record<string, unknown> | null,
  authorization: '',
  path: '',
}

const LONG_CONTENT = `${'长'.repeat(1500)}`
const SHORT_CONTENT = '这是一段很短的正文。'

const RESULT_A = {
  rerank_score: 2.4,
  title: 'DeepSeek 搜索接口文档',
  url: 'https://api-docs.deepseek.com/zh-cn/guides/search',
  snippet: 'Search 接口按 query 搜索网页，返回结构化结果。',
  summary: 'Search 与 Fetch 都是原始 JSON API，使用 Bearer 鉴权；按成功请求次数计费。',
  content: LONG_CONTENT,
  site_name: 'DeepSeek API Docs',
  site_icon: 'https://api-docs.deepseek.com/favicon.ico',
  date: '2026-10-17T00:00:00+00:00',
  authority: 3,
}

const RESULT_B = {
  rerank_score: 1.2,
  title: '没有链接的结果（应被丢掉）',
  url: '',
  snippet: '',
  summary: '',
  content: '',
  site_name: null,
  date: null,
  authority: -1,
}

const RESULT_C = {
  title: '第三方转载',
  url: 'https://example.com/repost',
  snippet: '转载内容',
  summary: '转载摘要',
  content: SHORT_CONTENT,
  site_name: null,
  date: null,
  rerank_score: 0.9,
  authority: 0,
}

let server: Server
let base = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/tools/search') {
      res.statusCode = 404
      res.end('{}')
      return
    }
    state.path = req.url
    state.authorization = String(req.headers.authorization ?? '')
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      state.body = JSON.parse(raw) as Record<string, unknown>
      if (state.mode === 'ok') {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ results: [RESULT_A, RESULT_B, RESULT_C] }))
        return
      }
      if (state.mode === 'empty') {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ results: [] }))
        return
      }
      const status = Number(state.mode)
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(
        JSON.stringify({ error: { message: `上游说明 ${status}`, type: 'invalid_request_error' } }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** 造一次调用：配置与秘钥直接进配置来源（走一遍默认值合并与 env 夹紧） */
const build = async (
  options: {
    config?: Record<string, unknown>
    secrets?: Record<string, string>
    envelope?: unknown
  } = {},
) => {
  const deps = buildToolStackDeps()
  deps.source.set(TOOL_KEYS.webSearch, {
    config: { baseUrl: base, allowPrivateNetwork: true, ...options.config },
    ...(options.secrets ? { secrets: options.secrets } : {}),
  })
  const tool = new WebTools(silentLogger as never)
  const spec = specByKey(tool, TOOL_KEYS.webSearch)
  const settings = await deps.config.settings(spec)
  const ctx = makeToolContext({ spec, settings, envelope: options.envelope ?? null })
  return { spec, ctx, deps }
}

const reasonOf = async (run: Promise<unknown>): Promise<ToolDeniedError> => {
  const error = await run.catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(ToolDeniedError)
  return error as ToolDeniedError
}

describe('web-search（搜索来源）', () => {
  it('协议映射：请求体带 query / count / need_content / ori_question，出参换成我们的字段', async () => {
    state.mode = 'ok'
    const { spec, ctx } = await build({ secrets: { apiKey: 'sk-test' } })
    const output = (await spec.exec(
      { query: 'DeepSeek 搜索 API', count: 5, needContent: false, question: '怎么用搜索接口？' },
      ctx as never,
    )) as WebSearchOutput

    // 发出去的东西：路径、鉴权、请求体
    expect(state.path).toBe('/v1/tools/search')
    expect(state.authorization).toBe('Bearer sk-test')
    expect(state.body).toMatchObject({
      query: 'DeepSeek 搜索 API',
      count: 5,
      need_content: false,
      ori_question: '怎么用搜索接口？',
    })

    // 收回来：没有 url 的条目被丢掉，其余字段换成我们的名字
    expect(output.returned).toBe(2)
    expect(output.results).toHaveLength(2)
    expect(output.results[0]).toMatchObject({
      title: 'DeepSeek 搜索接口文档',
      url: 'https://api-docs.deepseek.com/zh-cn/guides/search',
      site: 'DeepSeek API Docs',
      date: '2026-10-17T00:00:00+00:00',
      score: 2.4,
      authority: 3,
    })
    // 没要正文就不给 content（省上下文）
    expect(output.results[0]?.content).toBeUndefined()
    expect(output.next).toContain('web-fetch')
  })

  it('needContent：带正文，超过上限的截断并标记，短的保持原样', async () => {
    state.mode = 'ok'
    const { spec, ctx } = await build({ secrets: { apiKey: 'sk-test' } })
    const output = (await spec.exec(
      { query: 'DeepSeek 搜索 API', needContent: true },
      ctx as never,
    )) as WebSearchOutput

    expect(state.body?.need_content).toBe(true)
    const first = output.results[0]
    expect(first?.contentTruncated).toBe(true)
    expect(first?.content?.endsWith('…')).toBe(true)
    expect(first?.content?.length).toBe(1201)

    const third = output.results[1]
    expect(third?.content).toBe(SHORT_CONTENT)
    expect(third?.contentTruncated).toBe(false)
  })

  it('空结果是正常结束：不抛错，给"换关键词"的结论', async () => {
    state.mode = 'empty'
    const { spec, ctx } = await build({ secrets: { apiKey: 'sk-test' } })
    const output = (await spec.exec({ query: '不存在的关键词' }, ctx as never)) as WebSearchOutput

    expect(output.returned).toBe(0)
    expect(output.results).toEqual([])
    expect(output.notice).toContain('没有搜到')
  })

  it('密钥优先级：显式配置 > 当前轮 DeepSeek 官方模型；显式配置赢', async () => {
    state.mode = 'ok'
    const envelope = { model: { providerKind: 'deepseek', apiKey: 'sk-from-model' } }
    const { spec, ctx } = await build({
      secrets: { apiKey: 'sk-configured' },
      envelope,
    })
    await spec.exec({ query: 'x' }, ctx as never)

    expect(state.authorization).toBe('Bearer sk-configured')
  })

  it('没配秘钥时复用当前轮 DeepSeek 官方模型的密钥（不重复录入同一把 key）', async () => {
    state.mode = 'ok'
    const envelope = { model: { providerKind: 'deepseek', apiKey: 'sk-from-model' } }
    const { spec, ctx } = await build({ envelope })

    expect(await spec.precheck?.({ query: 'x' } as never, ctx as never)).toBeNull()
    await spec.exec({ query: 'x' }, ctx as never)
    expect(state.authorization).toBe('Bearer sk-from-model')
  })

  it('当前模型不是 DeepSeek 官方、又没配秘钥：precheck 直接给结论（别让模型反复改 query）', async () => {
    const envelope = { model: { providerKind: 'openai-compatible', apiKey: 'sk-openai' } }
    const { spec, ctx } = await build({ envelope })

    const reason = await spec.precheck?.({ query: 'x' } as never, ctx as never)
    expect(String(reason)).toContain('DeepSeek 密钥')
  })

  it('改过 baseURL 的 DeepSeek 供应商不复用密钥（代理的 key 打官方接口只会 401）', async () => {
    const envelope = {
      model: { providerKind: 'deepseek', baseURL: 'https://proxy.example.com', apiKey: 'sk-proxy' },
    }
    const { spec, ctx } = await build({ envelope })

    const reason = await spec.precheck?.({ query: 'x' } as never, ctx as never)
    expect(String(reason)).toContain('DeepSeek 密钥')
  })

  it('precheck：空白搜索词被拦下', async () => {
    const { spec, ctx } = await build({ secrets: { apiKey: 'sk-test' } })
    const reason = await spec.precheck?.({ query: '   ' } as never, ctx as never)
    expect(String(reason)).toContain('搜索词')
  })

  it('401：翻成 precheck-failed，并说清"改 query 没用"', async () => {
    state.mode = '401'
    const { spec, ctx } = await build({ secrets: { apiKey: 'sk-bad' } })
    const error = await reasonOf(spec.exec({ query: 'x' }, ctx as never))

    expect(error.reason).toBe('precheck-failed')
    expect(error.message).toContain('401')
    expect(String(error.hint)).toContain('web-search')
  })

  it('402：余额不足，不当作"没有结果"', async () => {
    state.mode = '402'
    const { spec, ctx } = await build({ secrets: { apiKey: 'sk-test' } })
    const error = await reasonOf(spec.exec({ query: 'x' }, ctx as never))

    expect(error.reason).toBe('precheck-failed')
    expect(error.message).toContain('余额不足')
  })

  it('429：限流可重试（retryable = true），并说明账号级 QPS', async () => {
    state.mode = '429'
    const { spec, ctx } = await build({ secrets: { apiKey: 'sk-test' } })
    const error = await reasonOf(spec.exec({ query: 'x' }, ctx as never))

    expect(error.reason).toBe('rate-limited')
    expect(error.retryable).toBe(true)
    expect(String(error.hint)).toContain('100 QPS')
  })

  it('5xx：算服务端错误、可重试，不归成"入参不合法"', async () => {
    state.mode = '500'
    const { spec, ctx } = await build({ secrets: { apiKey: 'sk-test' } })
    const error = await reasonOf(spec.exec({ query: 'x' }, ctx as never))

    expect(error.reason).toBe('internal')
    expect(error.retryable).toBe(true)
  })

  it('配置归一化：env 关掉联网时能力级开关跟着关，超时夹到 env 上限', async () => {
    const tool = new WebTools(silentLogger as never)
    const spec = specByKey(tool, TOOL_KEYS.webSearch)
    const caps = {
      pageBytesMax: 8 * 1024,
      maxPagesPerTurnMax: 5,
      web: { enabled: false, timeoutMsMax: 5_000, maxBytesMax: 1024 * 1024, allowPrivateNetwork: false },
    }
    const normalized = spec.normalize?.(
      { enabled: true, baseUrl: 'https://api.deepseek.com', timeoutMs: 60_000, allowPrivateNetwork: true },
      caps as never,
    )

    expect(normalized).toMatchObject({ enabled: false, timeoutMs: 5_000, allowPrivateNetwork: false })
  })
})
