import { describe, expect, it } from 'vitest'
import { WebToolError, htmlToMarkdown } from '../src/index.js'

describe('@repo/web-runtime', () => {
  it('HTML 转 Markdown 保留标题与正文', () => {
    expect(htmlToMarkdown('<h1>标题</h1><p>正文</p>')).toContain('# 标题')
  })

  it('WebToolError 带 reason / retryable，调用方可直接翻结论', () => {
    const error = new WebToolError('拒绝访问', '换来源')
    expect(error.reason).toBe('invalid-input')
    expect(error.retryable).toBe(false)
    expect(error.hint).toBe('换来源')
  })
})
