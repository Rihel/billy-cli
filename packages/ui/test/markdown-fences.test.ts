import { describe, expect, it } from 'vitest'

import {
  buildSandboxDocument,
  FENCE_LANGUAGES,
  parseXflowSpec,
  SANDBOX_CSP,
} from '../src/components/ai-elements/markdown-fences/fence-spec.ts'
import { layoutXflow, XFLOW_NODE_SIZE } from '../src/components/ai-elements/markdown-fences/xflow-layout.ts'
import { RENDERED_FENCE_LANGUAGES } from '../src/components/ai-elements/markdown-fences/renderers.tsx'

/**
 * 富内容围栏的纯逻辑测试。
 *
 * 这几个函数的输出直接决定"画出来对不对"：解析错了会画出错的图，排版错了节点会重叠，
 * 沙箱文档漏了 CSP 就是不设防。所以边界都在这里钉住，组件层只做冒烟。
 */

const panel = (overrides: Record<string, unknown> = {}) => ({
  title: '一轮对话',
  direction: 'LR',
  nodes: [
    { id: 'user', label: '用户消息', kind: 'start' },
    { id: 'agent', label: '主 agent', description: '决定怎么走' },
    { id: 'done', label: '落库', kind: 'end' },
  ],
  edges: [
    { from: 'user', to: 'agent' },
    { from: 'agent', to: 'done' },
  ],
  ...overrides,
})

describe('parseXflowSpec', () => {
  it('合法输入原样解析，缺省字段补默认值', () => {
    const result = parseXflowSpec(JSON.stringify(panel()))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.model.title).toBe('一轮对话')
    expect(result.model.direction).toBe('LR')
    expect(result.model.nodes.map((node) => node.id)).toEqual(['user', 'agent', 'done'])
    // 没写 kind 的当普通步骤
    expect(result.model.nodes[1]?.kind).toBe('process')
    expect(result.model.nodes[1]?.description).toBe('决定怎么走')
  })

  it('direction 只认 TB，其它值退回 LR', () => {
    const result = parseXflowSpec(JSON.stringify(panel({ direction: 'diagonal' })))
    expect(result.ok && result.model.direction).toBe('LR')
  })

  it('非 JSON 直接报错，不猜', () => {
    const result = parseXflowSpec('graph TD\nA-->B')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('JSON')
  })

  it('缺少 nodes、id 重复、边指向不存在的节点都报错', () => {
    const missing = parseXflowSpec(JSON.stringify({ edges: [] }))
    expect(missing.ok).toBe(false)

    const duplicated = parseXflowSpec(
      JSON.stringify({ nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }], edges: [] }),
    )
    expect(duplicated.ok).toBe(false)
    if (!duplicated.ok) expect(duplicated.error).toContain('重复')

    const dangling = parseXflowSpec(
      JSON.stringify({ nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'ghost' }] }),
    )
    expect(dangling.ok).toBe(false)
    if (!dangling.ok) expect(dangling.error).toContain('ghost')
  })

  it('节点超过上限时拒绝，避免画出看不出结构的图', () => {
    const nodes = Array.from({ length: 61 }, (_, index) => ({ id: `n${index}`, label: `N${index}` }))
    const result = parseXflowSpec(JSON.stringify({ nodes, edges: [] }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('上限')
  })
})

describe('layoutXflow', () => {
  const model = (() => {
    const parsed = parseXflowSpec(JSON.stringify(panel()))
    if (!parsed.ok) throw new Error(parsed.error)
    return parsed.model
  })()

  it('按最长路径分列：LR 时 x 递增、同列 y 不同', () => {
    const layout = layoutXflow(model)
    const [user, agent, done] = layout.nodes
    expect(user && agent && done).toBeTruthy()
    expect(user!.x).toBeLessThan(agent!.x)
    expect(agent!.x).toBeLessThan(done!.x)
    // 三个节点各占一列，纵向都居中在同一行
    expect(new Set([user!.y, agent!.y, done!.y]).size).toBe(1)
  })

  it('同列多个节点纵向排开，间距不小于节点高度', () => {
    const parsed = parseXflowSpec(
      JSON.stringify({
        nodes: [
          { id: 'root', label: '根' },
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
        edges: [
          { from: 'root', to: 'a' },
          { from: 'root', to: 'b' },
        ],
      }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const layout = layoutXflow(parsed.model)
    const [root, a, b] = layout.nodes
    expect(root!.x).toBeLessThan(a!.x)
    expect(a!.x).toBe(b!.x)
    expect(Math.abs(a!.y - b!.y)).toBeGreaterThanOrEqual(XFLOW_NODE_SIZE.height)
  })

  it('TB 方向把列换成行：y 递增、x 相同', () => {
    const parsed = parseXflowSpec(JSON.stringify(panel({ direction: 'TB' })))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const layout = layoutXflow(parsed.model)
    const [user, agent, done] = layout.nodes
    expect(user!.y).toBeLessThan(agent!.y)
    expect(agent!.y).toBeLessThan(done!.y)
    expect(new Set([user!.x, agent!.x, done!.x]).size).toBe(1)
  })

  it('结果确定：同一份数据排两次完全一致', () => {
    expect(layoutXflow(model)).toEqual(layoutXflow(model))
  })

  it('有环也能排完，不会死循环', () => {
    const parsed = parseXflowSpec(
      JSON.stringify({
        nodes: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const layout = layoutXflow(parsed.model)
    expect(layout.nodes).toHaveLength(2)
    expect(Number.isFinite(layout.width)).toBe(true)
    expect(Number.isFinite(layout.height)).toBe(true)
  })
})

describe('buildSandboxDocument', () => {
  const theme = { background: 'rgb(0, 0, 0)', color: 'rgb(255, 255, 255)' }

  it('带上禁网 CSP：只放行内联脚本与样式', () => {
    const doc = buildSandboxDocument({ html: '<p>hi</p>', theme })
    expect(doc).toContain('Content-Security-Policy')
    expect(doc).toContain(SANDBOX_CSP)
    expect(SANDBOX_CSP).toContain("default-src 'none'")
    expect(SANDBOX_CSP).toContain("script-src 'unsafe-inline'")
    expect(SANDBOX_CSP).toContain("connect-src 'none'")
    // 不允许任何外部主机（一旦出现 http(s) 源，沙箱就等于开了口子）
    expect(SANDBOX_CSP).not.toMatch(/https?:/)
  })

  it('预置脚本在模型内容之前、高度回报脚本最后', () => {
    const doc = buildSandboxDocument({
      html: '<div id="stage">舞台</div>',
      scripts: ['window.__gsap = true'],
      theme,
    })
    const htmlAt = doc.indexOf('<div id="stage">')
    const scriptAt = doc.indexOf('window.__gsap = true')
    const reporterAt = doc.indexOf('__fenceHeight')
    expect(htmlAt).toBeGreaterThan(-1)
    // 库必须先于模型的内联脚本执行，否则模型代码里 `gsap is not defined`
    expect(scriptAt).toBeGreaterThan(-1)
    expect(scriptAt).toBeLessThan(htmlAt)
    expect(reporterAt).toBeGreaterThan(htmlAt)
  })

  it('脚本文本里的 </script> 被转义，不会提前闭合标签', () => {
    const doc = buildSandboxDocument({ html: '', scripts: ['var s = "</script>"'], theme })
    expect(doc).not.toContain('var s = "</script>"')
    expect(doc).toContain('<\\/script')
  })

  it('拦截预览里的外部链接，避免相对链接把 iframe 导航到后台页面', () => {
    const doc = buildSandboxDocument({ html: '<a href="/main/ai/files">链接</a>', theme })
    expect(doc).toContain('closest?target.closest')
    expect(doc).toContain("href.charAt(0)==='#'")
    expect(doc).toContain('preventDefault')
  })

  it('主题底色与字色写进基础样式（深色页面里不会蹦出一块白）', () => {
    const doc = buildSandboxDocument({ html: '', theme })
    expect(doc).toContain('rgb(0, 0, 0)')
    expect(doc).toContain('rgb(255, 255, 255)')
  })
})

describe('围栏注册表', () => {
  it('四类新围栏都注册了，语言标识与常量一致', () => {
    expect(new Set(RENDERED_FENCE_LANGUAGES)).toEqual(
      new Set([FENCE_LANGUAGES.xflow, FENCE_LANGUAGES.html, FENCE_LANGUAGES.gsap, FENCE_LANGUAGES.json]),
    )
  })
})
