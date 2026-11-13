import { describe, expect, it } from 'vitest'
import { detectAntiBot } from '../../src/modules/ai/tools/web/markdown.js'

/**
 * **反爬 / 人机验证识别**的单测（不打网络，喂固定页面）。
 *
 * 为什么值得单独测：403 的正文和"页面本来就没内容"一样是空的，
 * 但两种结论让模型做的下一件事完全不同 ——
 * 判成"页面没内容"它会反复重试，判成"被拦了"它才会换来源。
 */

/** 百度百科真实的拦截页结构（正文只有一个空 body + 一段加载脚本，标题是验证页名） */
const BAIDU_BLOCK = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><title>百度安全验证</title><style>body{margin:0}</style>
</head><body></body><script>loadScript('/wappass')</script></html>`

/** Cloudflare 的经典验证页 */
const CF_BLOCK = `<!DOCTYPE html><html><head><title>Just a moment...</title></head>
<body><div class="cf-browser-verification">Checking your browser</div></body></html>`

/** 一篇正常文章里恰好提到"验证码"：不该被判成验证页 */
const NORMAL_ARTICLE = `<html><head><title>登录流程设计</title></head><body>
<h1>登录流程设计</h1>
<p>在登录页加验证码，可以有效防止撞库。验证码的类型有图形验证码、短信验证码与行为验证三类，
选择时要权衡安全与转化率。下面是一个典型的实现方案，包含前端展示、后端校验与失败重试。</p>
${'<p>这一段是用来把正文撑长的占位内容，保证它不会被当成"正文极短的验证页"。</p>\n'.repeat(20)}
</body></html>`

describe('反爬 / 人机验证识别', () => {
  it('403 + 百度安全验证 → 认出是百度的人机验证', () => {
    expect(detectAntiBot({ status: 403, title: '百度安全验证', html: BAIDU_BLOCK })).toBe(
      '百度安全验证',
    )
  })

  it('403 + Cloudflare 验证页 → 认出是 Cloudflare', () => {
    expect(detectAntiBot({ status: 403, title: 'Just a moment...', html: CF_BLOCK })).toBe(
      'Cloudflare 验证',
    )
  })

  it('拒绝类状态 + 正文极短 → 也当被拦（正常页面不会这么短）', () => {
    expect(detectAntiBot({ status: 403, title: 'Error', html: '<html><body></body></html>' })).toBe(
      'HTTP 403',
    )
  })

  it('正常文章里出现"验证码"不该被误判（正文够长 + 状态是 200）', () => {
    expect(detectAntiBot({ status: 200, title: '登录流程设计', html: NORMAL_ARTICLE })).toBeNull()
  })

  it('200 + 有正文 → 不是拦截页', () => {
    const html = `<html><head><title>标题</title></head><body><h1>标题</h1><p>${'内容'.repeat(200)}</p></body></html>`
    expect(detectAntiBot({ status: 200, title: '标题', html })).toBeNull()
  })
})
