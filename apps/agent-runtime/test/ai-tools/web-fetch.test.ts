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
 * `web-fetch` 的单测：**真的发 HTTP**（本机起一个临时服务，不碰外网）。
 *
 * 验的是四条最容易坏、坏了最难看的东西：
 * 1. **转换**：HTML → Markdown（标题 / 表格留着，脚本与样式丢掉）；
 * 2. **分页**：1 页 1000 行的口径、页脚那句"共几页 / 当前第几页 / 还剩几页"；
 * 3. **缓存**：翻页**不许**再打一次网络（同一个 ref 只请求一次）；
 * 4. **闸门**：没开 `allowPrivateNetwork` 时内网地址必须被拒。
 */

/** 一份有标题、有表格、有脚本与样式的页面（噪声与结构都要有，才测得出"洗没洗干净"） */
const PAGE = `<!doctype html>
<html><head>
<title>测试页面 &amp; 标题</title>
<style>.noise { color: red }</style>
</head>
<body>
<h1>主标题</h1>
<p>第一段正文。</p>
<script>console.log('脚本不该出现在正文里')</script>
<table>
  <tr><th>键</th><th>值</th></tr>
  <tr><td>alpha</td><td>1</td></tr>
</table>
${Array.from({ length: 12 }, (_, index) => `<p>第 ${index + 1} 段</p>`).join('\n')}
</body></html>`

const hits = { doc: 0, missing: 0, userAgent: '' }

let server: Server
let base = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.userAgent = String(req.headers['user-agent'] ?? '')
    if (req.url === '/doc') {
      hits.doc += 1
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(PAGE)
      return
    }
    if (req.url === '/missing') {
      hits.missing += 1
      res.statusCode = 404
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end('<html><body><h1>没有这个页面</h1></body></html>')
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** 造一次调用：`config` 直接进配置来源（走一遍 `settings()` 的默认值合并与 env 夹紧） */
const build = async (config: Record<string, unknown> = {}) => {
  const deps = buildToolStackDeps()
  deps.source.set(TOOL_KEYS.webFetch, {
    config: { allowPrivateNetwork: true, pageLines: 4, ...config },
  })
  const tool = new WebTools(silentLogger as never)
  const spec = specByKey(tool, TOOL_KEYS.webFetch)
  const settings = await deps.config.settings(spec)
  const ctx = makeToolContext({ spec, settings })
  return { spec, ctx }
}

describe('web-fetch（抓网页转 Markdown）', () => {
  it('HTML 洗成 Markdown：标题与表格留着，脚本与样式丢掉；统一浏览器 UA', async () => {
    // 这一条只关心"洗得干不干净"，所以一页装得下全部内容（分页另有专测）
    const { spec, ctx } = await build({ pageLines: 200 })
    const page = (await spec.exec({ url: `${base}/doc` }, ctx as never)) as WebPageOutput

    expect(page.status).toBe(200)
    expect(page.title).toBe('测试页面 & 标题')
    expect(page.content).toContain('# 主标题')
    // 表格必须还是表格（默认 Turndown 会把它拍平）
    expect(page.content).toContain('| 键 | 值 |')
    expect(page.content).toContain('| alpha | 1 |')
    // 噪声节点要真的没了
    expect(page.content).not.toContain('脚本不该出现在正文里')
    expect(page.content).not.toContain('color: red')
    // 统一 UA：站点该看到一个浏览器，而不是 Node 的默认 UA
    expect(hits.userAgent).toContain('Mozilla/5.0')
    expect(hits.userAgent).toContain('Chrome/')
    // 元信息：多少字符 / 多少行 / 多少页
    expect(page.document.chars).toBeGreaterThan(0)
    expect(page.document.lines).toBeGreaterThan(3)
    expect(page.document.pages).toBe(1)
    expect(page.document.pageLines).toBe(200)
  })

  it('分页：每页 4 行，页脚写清"共几页 / 当前第几页 / 还剩几页"，最后一页直说', async () => {
    const { spec, ctx } = await build()
    const first = (await spec.exec({ url: `${base}/doc` }, ctx as never)) as WebPageOutput

    expect(first.page.total).toBeGreaterThan(1)
    expect(first.page.current).toBe(1)
    expect(first.page.isLast).toBe(false)
    expect(first.footer).toBe(
      `共 ${first.page.total} 页，当前第 1 页，还剩 ${first.page.total - 1} 页（1 页 = 4 行）`,
    )
    // 页脚同时出现在正文末尾（模型读到哪儿，那句话就在哪儿）
    expect(first.content.endsWith(first.footer)).toBe(true)

    const last = (await spec.exec(
      { ref: first.ref, page: first.page.total },
      ctx as never,
    )) as WebPageOutput
    expect(last.page.isLast).toBe(true)
    expect(last.page.remaining).toBe(0)
    expect(last.footer).toBe(`共 ${last.page.total} 页，当前第 ${last.page.total} 页，最后一页`)
  })

  it('翻页走缓存：同一个 ref 再取一页**不会再发请求**', async () => {
    const { spec, ctx } = await build()
    const before = hits.doc
    const first = (await spec.exec({ url: `${base}/doc` }, ctx as never)) as WebPageOutput
    const second = (await spec.exec({ ref: first.ref, page: 2 }, ctx as never)) as WebPageOutput

    expect(hits.doc).toBe(before + 1) // 只发了一次
    expect(first.cached).toBe(false)
    expect(second.cached).toBe(true)
    expect(second.content).not.toBe(first.content)
    // 页码越界不炸：夹到最后一页并说明
    const beyond = (await spec.exec(
      { ref: first.ref, page: first.page.total + 9 },
      ctx as never,
    )) as WebPageOutput
    expect(beyond.page.current).toBe(beyond.page.total)
    expect(String(beyond.notice)).toContain('只有')
  })

  it('同一份地址重复调用：复用缓存，不重复打网络', async () => {
    const { spec, ctx } = await build()
    const before = hits.doc
    await spec.exec({ url: `${base}/doc` }, ctx as never)
    const again = (await spec.exec({ url: `${base}/doc` }, ctx as never)) as WebPageOutput
    expect(hits.doc).toBe(before + 1)
    expect(again.cached).toBe(true)
  })

  it('ref 过期（不存在的句柄）给可纠正的结论，而不是空内容', async () => {
    const { spec, ctx } = await build()
    await expect(spec.exec({ ref: 'deadbeef0000' }, ctx as never)).rejects.toThrow(/缓存里已经没有/)
  })

  it('没开 allowPrivateNetwork 时内网地址被拒（SSRF 闸门）', async () => {
    const { spec, ctx } = await build({ allowPrivateNetwork: false })
    await expect(spec.exec({ url: `${base}/doc` }, ctx as never)).rejects.toThrow(/拒绝访问/)
  })

  it('非 2xx 不抛错：状态码与错误页正文照样给模型', async () => {
    const { spec, ctx } = await build()
    const page = (await spec.exec({ url: `${base}/missing` }, ctx as never)) as WebPageOutput
    expect(page.status).toBe(404)
    expect(page.content).toContain('没有这个页面')
  })

  it('precheck：url 与 ref 都不给时返回一句说明', async () => {
    const { spec, ctx } = await build()
    const reason = await spec.precheck?.({} as never, ctx as never)
    expect(String(reason)).toContain('url')
  })
})
