import { describe, expect, it } from 'vitest'
import { isChatPath, sectionOf } from '../src/lib/sections'
import { Pages } from '../src/lib/constants'

/**
 * 顶层分区判据（node 环境，纯函数）。
 *
 * 为什么值得锁：顶栏「会话 / 管理」的高亮与跳转全靠这一条判据。
 * 前缀边界写漏一次，就会把 `/main/ai/chatxxx` 这类路径算进会话分区 ——
 * 症状是"停在管理页，顶栏却亮着会话"，而且只有手点才看得见。
 */
describe('顶层分区判据', () => {
  it('会话根路径与它下面的会话都算「会话」', () => {
    expect(sectionOf(Pages.chat)).toBe('chat')
    expect(sectionOf(`${Pages.chat}/new`)).toBe('chat')
    expect(sectionOf(`${Pages.chat}/AbC123`)).toBe('chat')
    expect(isChatPath(`${Pages.chat}/AbC123`)).toBe(true)
  })

  it('管理台的页面都算「管理」', () => {
    expect(sectionOf(Pages.dashboard)).toBe('console')
    expect(sectionOf('/main/ai/tools')).toBe('console')
    expect(sectionOf('/main/monitor/live')).toBe('console')
    expect(sectionOf('/main/system/users')).toBe('console')
    expect(sectionOf('/main/user-center')).toBe('console')
    // 技能编辑器是画布布局，但分区归属仍是管理
    expect(sectionOf('/main/ai/skills/demo')).toBe('console')
  })

  it('前缀必须带分隔符：兄弟路径不能算进会话', () => {
    expect(isChatPath('/main/ai/chatxxx')).toBe(false)
    expect(sectionOf('/main/ai/chats')).toBe('console')
  })
})
