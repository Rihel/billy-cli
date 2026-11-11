import { describe, expect, it } from 'vitest'
import { skillWriteOf } from '../src/app/(standalone)/main/ai/chat/skill-tool'

/**
 * 工具卡把 `skill-save` / `skill-import` 识别成"技能写入"：
 * - `skill-save` 入参里带正文，未落库时也能先预览；
 * - `skill-import` 只有结果里才有技能名，不能凭空造。
 */
const part = (input: unknown, output?: unknown, state = 'output-available') =>
  ({
    type: 'dynamic-tool',
    toolName: 'skill-save',
    toolCallId: 'c1',
    state,
    input,
    ...(output !== undefined ? { output } : {}),
  }) as never

describe('skillWriteOf', () => {
  it('skill-save：取技能名 / 描述 / 正文 / 文件，状态由 created 推出', () => {
    const info = skillWriteOf(
      part(
        {
          skillKey: 'demo-skill',
          description: '什么时候用',
          body: '# 正文',
          files: [{ path: 'references/a.md', content: 'A' }],
        },
        { ok: true, created: true, skillKey: 'demo-skill', version: 1 },
      ),
    )
    expect(info).toMatchObject({
      tool: 'skill-save',
      entries: [{ skillKey: 'demo-skill', status: 'created' }],
      draft: {
        description: '什么时候用',
        body: '# 正文',
        files: [{ path: 'references/a.md', content: 'A' }],
      },
      finished: true,
    })
  })

  it('skill-save：流式中没有 output 也能给出预览（finished=false）', () => {
    const info = skillWriteOf(
      part({ skillKey: 'demo-skill', body: 'x' }, undefined, 'input-available'),
    )
    expect(info).toMatchObject({ finished: false, entries: [{ skillKey: 'demo-skill' }] })
  })

  it('skill-import：从结果 items 里取技能名与状态', () => {
    const info = skillWriteOf(
      {
        type: 'dynamic-tool',
        toolName: 'skill-import',
        toolCallId: 'c2',
        state: 'output-available',
        input: { url: 'https://skills.sh/a/b/c' },
        output: {
          source: 'a/b/c',
          items: [
            { skillKey: 'c', status: 'created', message: null },
            { skillKey: 'd', status: 'failed', message: 'x' },
          ],
          total: 2,
        },
      } as never,
    )
    expect(info).toMatchObject({
      tool: 'skill-import',
      source: 'a/b/c',
      entries: [
        { skillKey: 'c', status: 'created' },
        { skillKey: 'd', status: 'failed' },
      ],
    })
  })

  it('非技能写入工具 / 缺技能名 → null', () => {
    expect(skillWriteOf({ type: 'dynamic-tool', toolName: 'skill-list', input: {} } as never)).toBeNull()
    expect(skillWriteOf(part({ body: 'x' }))).toBeNull()
  })
})
