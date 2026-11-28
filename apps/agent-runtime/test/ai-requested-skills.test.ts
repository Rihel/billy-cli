import { describe, expect, it } from 'vitest'
import {
  requestedSkillsOf,
  requestedSkillsSection,
} from '../src/modules/ai/tools/skills/requested-skills.js'
import type { SkillRef } from '../src/modules/ai/tools/skills/skills.types.js'

/**
 * `/技能名` 点名：只认**可见技能**里的名字，且必须是独占一个词的词元。
 * 识别错了有两个方向的代价：漏识别 = 用户点了技能却没用；误识别 = 普通斜杠文本被当成指令。
 */
const available: SkillRef[] = [
  { name: 'design-taste-frontend', description: '做前端页面', path: '/tmp/a' },
  { name: 'humanizer-zh', description: '润色中文', path: '/tmp/b' },
]

describe('requestedSkillsOf', () => {
  it('按出现顺序识别已知技能，重复只算一次', () => {
    expect(
      requestedSkillsOf('/humanizer-zh 用 /design-taste-frontend 做页 /humanizer-zh', available),
    ).toEqual(['humanizer-zh', 'design-taste-frontend'])
  })

  it('不在可见集合里的名字不算（/etc/passwd、/help）', () => {
    expect(requestedSkillsOf('/etc/passwd 和 /help', available)).toEqual([])
  })

  it('词元必须独占一个词：前缀相同不算', () => {
    expect(requestedSkillsOf('/design-taste-frontend-x 做页', available)).toEqual([])
    expect(requestedSkillsOf('/design-taste-frontend做页', available)).toEqual([])
  })

  it('没有斜杠 / 空串直接返回空', () => {
    expect(requestedSkillsOf('帮我做个页面', available)).toEqual([])
    expect(requestedSkillsOf('', available)).toEqual([])
  })
})

describe('requestedSkillsSection', () => {
  it('没有点名技能时不追加任何内容', () => {
    expect(requestedSkillsSection([])).toBe('')
  })

  it('列出技能名并要求先读正文再动手', () => {
    const section = requestedSkillsSection(['design-taste-frontend'])
    expect(section).toContain('## 本轮显式指定的技能')
    expect(section).toContain('`design-taste-frontend`')
    expect(section).toContain('.agents/<技能名>/SKILL.md')
  })
})
