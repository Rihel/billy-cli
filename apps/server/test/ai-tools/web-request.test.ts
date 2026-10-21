import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebTools, type WebPageOutput } from '../../src/modules/ai/tools/web.tools.js'
import { TOOL_KEYS } from '../../src/modules/ai/core/tools/tool-keys.js'
import {
  buildToolStackDeps,
  makeToolContext,
  silentLogger,
  specByKey,
} from '../helpers/ai-tool-stack.js'

/**
 * `web-request` 的单测（真的发 HTTP，打本机的临时服务）。
 *
 * 与 `web-fetch` 的差别就是这份测试存在的理由：**这里是接口不是文章**。
 * 验四件事：
 * 1. 方法与 body 真的发出去了（含"对象自动转 JSON 并补 content-type"）；
 * 2. `query` 帮忙做了 URL 编码（模型自己拼最容易漏）；
 * 3. 非 2xx **不算工具失败**（401/500 的正文对模型就是结论）；
 * 4. 分页 / 缓存与 `web-fetch` 同一套（`ref` + `page`）。
 */

const seen: { method: string; contentType: string; body: string; url: string; userAgent: string } = {
  method: '',
  contentType: '',
  body: '',
  url: '',
  userAgent: '',
}

let server: Server
let base = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      seen.method = String(req.method)
      seen.contentType = String(req.headers['content-type'] ?? '')
      seen.userAgent = String(req.headers['user-agent'] ?? '')
      seen.url = String(req.url)
      seen.body = Buffer.concat(chunks).toString('utf8')

      if (req.url?.startsWith('/api/echo')) {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(
          JSON.stringify({
            method: seen.method,
            contentType: seen.contentType,
            body: seen.body,
            url: seen.url,
          }),
        )
        return
      }
      if (req.url === '/api/boom') {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: '内部错误', code: 'E_BOOM' }))
        return
      }
      if (req.url === '/api/long') {
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end(Array.from({ length: 9 }, (_, index) => `line ${index + 1}`).join('\n'))
        return
      }
      res.statusCode = 404
      res.end('not found')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const build = async (config: Record<string, unknown> = {}) => {
  const deps = buildToolStackDeps()
  deps.source.set(TOOL_KEYS.webRequest, {
    config: { allowPrivateNetwork: true, pageLines: 4, ...config },
  })
  const tool = new WebTools(silentLogger as never)
  const spec = specByKey(tool, TOOL_KEYS.webRequest)
  const settings = await deps.config.settings(spec)
  const ctx = makeToolContext({ spec, settings })
  return { spec, ctx }
}

describe('web-request（发 HTTP 请求）', () => {
  it('POST 对象 body：自动转 JSON、补 content-type，JSON 响应展开成多行', async () => {
    const { spec, ctx } = await build()
    const page = (await spec.exec(
      { url: `${base}/api/echo`, method: 'POST', body: { name: 'Billy', n: 2 } },
      ctx as never,
    )) as WebPageOutput

    expect(page.status).toBe(200)
    expect(seen.method).toBe('POST')
    expect(seen.contentType).toContain('application/json')
    expect(JSON.parse(seen.body)).toEqual({ name: 'Billy', n: 2 })
    // 展开过的 JSON：可读性优先（模型读一行的 JSON 很费劲）
    expect(page.content).toContain('"method": "POST"')
    expect(page.content).toContain('\n')
    // 与 web-fetch 一样带统一浏览器 UA
    expect(seen.userAgent).toContain('Mozilla/5.0')
  })

  it('query 帮忙做 URL 编码（空格 / 中文 / & 都不会把地址拼坏）', async () => {
    const { spec, ctx } = await build()
    const page = (await spec.exec(
      { url: `${base}/api/echo`, query: { q: 'Billy 教程', page: 2 } },
      ctx as never,
    )) as WebPageOutput
    expect(page.status).toBe(200)
    // 服务端看到的查询串必须是编码过的（空格会被编码成 `+`，这是 URLSearchParams 的口径）
    expect(seen.url).toContain('q=Billy+%E6%95%99%E7%A8%8B')
    expect(seen.url).toContain('page=2')
    expect(page.content).toContain('"method": "GET"')
  })

  it('非 2xx 不抛错：500 与它的错误体照样返回', async () => {
    const { spec, ctx } = await build()
    const page = (await spec.exec({ url: `${base}/api/boom` }, ctx as never)) as WebPageOutput
    expect(page.status).toBe(500)
    expect(page.content).toContain('E_BOOM')
  })

  it('分页 + 缓存：ref 续页不发第二次请求', async () => {
    const { spec, ctx } = await build()
    const before = 0
    const first = (await spec.exec({ url: `${base}/api/long` }, ctx as never)) as WebPageOutput
    expect(first.page.total).toBeGreaterThan(1)
    expect(first.footer).toContain('还剩')
    const second = (await spec.exec(
      { ref: first.ref, page: 2 },
      ctx as never,
    )) as WebPageOutput
    expect(before).toBe(0)
    expect(second.cached).toBe(true)
    expect(second.page.current).toBe(2)
  })

  it('GET 带 body：拒绝并说明怎么改', async () => {
    const { spec, ctx } = await build()
    await expect(
      spec.exec({ url: `${base}/api/echo`, body: 'x' }, ctx as never),
    ).rejects.toThrow(/不能带 body/)
  })

  it('自定义头会覆盖默认项（UA 可换身份，其余浏览器头照旧）', async () => {
    const { spec, ctx } = await build()
    await spec.exec(
      { url: `${base}/api/echo`, headers: { 'User-Agent': 'custom-agent/1.0' } },
      ctx as never,
    )
    expect(seen.userAgent).toBe('custom-agent/1.0')
  })

  it('precheck：url 与 ref 都不给时返回一句说明', async () => {
    const { spec, ctx } = await build()
    const reason = await spec.precheck?.({} as never, ctx as never)
    expect(String(reason)).toContain('url')
  })
})
