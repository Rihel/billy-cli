import { describe, expect, it } from 'vitest'
import { askUserQuestionsTool } from '../../src/modules/ai/mastra/ask-user-questions.tool.js'

/**
 * `ask-user-questions` 的执行体（不启 agent、不跑 Mastra 运行时）：
 * - 有 `resumeData` → 把答案排成模型可读的一段；
 * - 没有 `suspend`（直接调用）→ 返回兜底问题文本，不静默丢。
 */
const execute = askUserQuestionsTool.execute as unknown as (
  input: unknown,
  context: unknown,
) => Promise<string | undefined>

const questions = [
  {
    id: 'goal',
    type: 'single' as const,
    title: '这份剧本给谁看？',
    options: [{ label: '长辈自己' }, { label: '子女看了去教' }],
  },
  {
    id: 'topics',
    type: 'multi' as const,
    title: '想先教哪几件？',
    options: [{ label: '接电话' }, { label: '发微信' }, { label: '拍照' }],
  },
  {
    id: 'note',
    type: 'text' as const,
    title: '还有什么要补充的？',
    required: false,
  },
]

describe('ask-user-questions', () => {
  it('续跑时把单选 / 多选 / 问答排成模型可读的答案', async () => {
    const text = await execute(
      { questions },
      {
        resumeData: {
          answers: [
            { id: 'goal', value: '长辈自己' },
            { id: 'topics', value: ['接电话', '拍照'] },
            { id: 'note', value: '字要大' },
          ],
        },
      },
    )
    expect(text).toContain('用户已回答')
    expect(text).toContain('这份剧本给谁看？')
    expect(text).toContain('长辈自己')
    expect(text).toContain('接电话、拍照')
    expect(text).toContain('字要大')
  })

  it('没有 suspend 的直调给兜底问题，不静默丢', async () => {
    const text = await execute({ questions }, {})
    expect(text).toContain('需要用户回答以下问题')
    expect(text).toContain('这份剧本给谁看？')
  })

  it('挂起时把整组问题交给 suspend', async () => {
    const calls: unknown[] = []
    const text = await execute(
      { questions },
      {
        suspend: async (payload: unknown) => {
          calls.push(payload)
        },
      },
    )
    expect(text).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ questions: expect.arrayContaining([expect.objectContaining({ id: 'goal' })]) })
  })
})
