import { describePlatform } from '@repo/kits'
import { describe, expect, it } from 'vitest'
import { buildEnvironmentData } from '../src/modules/ai/prompts/environment.js'
import { createPromptEngine } from '../src/modules/ai/prompts/index.js'

/**
 * 会话开局的「运行环境」片段（操作系统 + 当前时间）。
 *
 * 两个刻意的测法：
 * 1. **时间与时区都注入**：`new Date()` + 本机时区写进断言，等于没断言
 *    （换台机器就红/绿，且看不出是格式错了还是时区不同）；
 * 2. **平台画像注入三端取值**：跨平台代码只在本机跑过，等于另外两端没测。
 */
describe('运行环境片段（会话开局注入）', () => {
  const mac = describePlatform('darwin', '24.6.0', 'arm64')
  const windows = describePlatform('win32', '10.0.22631', 'x64')

  it('本地时间带时区与偏移，格式确定（时区注入 → 断言可复现）', () => {
    const data = buildEnvironmentData(new Date('2026-09-30T09:55:00Z'), mac, 'Asia/Shanghai')
    expect(data.os).toBe('macOS 24.6.0（darwin / arm64）')
    expect(data.shell).toBe('/bin/sh')
    expect(data.now).toBe('2026年9月30日星期三 17:55:00（Asia/Shanghai，UTC+08:00）')
  })

  it('Windows 画像：命令解释器是 cmd.exe（提示词里据此让模型写对语法）', () => {
    const data = buildEnvironmentData(new Date('2026-09-30T09:55:00Z'), windows, 'UTC')
    expect(data.os).toBe('Windows 10.0.22631（win32 / x64）')
    expect(data.shell.endsWith('cmd.exe') || data.shell.endsWith('CMD.EXE')).toBe(true)
  })

  it('模板渲染：数据经引擎渲染成提示词片段（提示词文本只走模板，不手拼）', () => {
    const engine = createPromptEngine()
    const text = engine.renderPartial(
      'partials/environment',
      buildEnvironmentData(new Date('2026-09-30T09:55:00Z'), mac, 'Asia/Shanghai'),
    )
    expect(text).toContain('运行环境')
    expect(text).toContain('操作系统：macOS 24.6.0（darwin / arm64）')
    expect(text).toContain('命令解释器：/bin/sh')
    expect(text).toContain('当前时间：2026年9月30日星期三 17:55:00（Asia/Shanghai，UTC+08:00）')
    // eta 标签写错会原样漏进提示词（正文里出现 `{{` 一定是模板坏了）
    expect(text).not.toContain('{{')
  })
})
