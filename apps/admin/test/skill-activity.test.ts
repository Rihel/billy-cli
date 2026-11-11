import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { activatedSkillsOf } from '../src/app/(standalone)/main/ai/chat/skill-activity'

/**
 * 右栏「技能」的统计口径：只认运行时 `skill` 工具的调用，并同时兼容
 * 历史消息（`dynamic-tool` + `toolName`）与实时消息（`tool-skill`）两种 parts。
 */
const message = (parts: unknown[]): UIMessage => ({ id: 'm', role: 'assistant', parts } as never)

describe('activatedSkillsOf', () => {
  it('历史形状（dynamic-tool）与实时形状（tool-skill）都能识别', () => {
    const result = activatedSkillsOf([
      message([
        { type: 'dynamic-tool', toolName: 'skill', input: { name: 'baolao-docs' } },
        { type: 'tool-skill', input: { name: 'baolao-docs' } },
        { type: 'tool-skill', input: { name: 'humanizer-zh' } },
      ]),
    ])
    expect(result).toEqual([
      { name: 'baolao-docs', calls: 2 },
      { name: 'humanizer-zh', calls: 1 },
    ])
  })

  it('只认 skill；skill_read / skill_search 不算激活', () => {
    const result = activatedSkillsOf([
      message([
        { type: 'tool-skill_read', input: { skillName: 'baolao-docs', path: 'references/a.md' } },
        { type: 'dynamic-tool', toolName: 'skill_search', input: { query: 'x' } },
        { type: 'dynamic-tool', toolName: 'skill', input: { name: 'baolao-docs' } },
      ]),
    ])
    expect(result).toEqual([{ name: 'baolao-docs', calls: 1 }])
  })

  it('缺入参 / 名字为空 / 非对象入参一律跳过（不猜）', () => {
    const result = activatedSkillsOf([
      message([
        { type: 'tool-skill' },
        { type: 'tool-skill', input: {} },
        { type: 'tool-skill', input: { name: '   ' } },
        { type: 'tool-skill', input: 'baolao-docs' },
        // 历史误调用：把 SKILL.md 的绝对路径当 name 传（不是合法技能名，不该出现在列表里）
        { type: 'tool-skill', input: { name: '/Users/rihel/.agents/skills/baolao-docs/SKILL.md' } },
        { type: 'tool-skill', input: { name: 'ok-skill' } },
      ]),
    ])
    expect(result).toEqual([{ name: 'ok-skill', calls: 1 }])
  })

  it('跨消息聚合；同次数按名字排序', () => {
    const result = activatedSkillsOf([
      message([{ type: 'tool-skill', input: { name: 'b-skill' } }]),
      message([
        { type: 'tool-skill', input: { name: 'a-skill' } },
        { type: 'tool-skill', input: { name: 'b-skill' } },
      ]),
    ])
    expect(result).toEqual([
      { name: 'b-skill', calls: 2 },
      { name: 'a-skill', calls: 1 },
    ])
  })
})
