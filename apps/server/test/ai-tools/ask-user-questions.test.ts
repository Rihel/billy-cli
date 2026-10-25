import { describe, expect, it } from 'vitest'
import { askUserQuestionsTool } from '../../src/modules/ai/mastra/ask-user-questions.tool.js'

/**
 * `ask-user-questions` 的执行体（不启 agent、不跑 Mastra 运行时）：
 * - 有 `resumeData` → 返回"给模型的文本 + 结构化答案"（时间线存结构，模型读文本）；
 * - 没有 `suspend`（直接调用）→ 返回兜底问题文本，不静默丢。
 */
const execute = askUserQuestionsTool.execute as unknown as (
  input: unknown,
  context: unknown,
) => Promise<{ text: string; answers: { id: string; value: string | string[] }[] } | string | undefined>

const toModelOutput = askUserQuestionsTool.toModelOutput as unknown as (output: unknown) => {
  type: string
  value: string
}

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
  it('续跑时返回结构化答案 + 给模型读的文本', async () => {
    const output = await execute(
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
    expect(typeof output).not.toBe('string')
    const result = output as { text: string; answers: unknown[] }
    expect(result.text).toContain('用户已回答')
    expect(result.text).toContain('这份剧本给谁看？')
    expect(result.text).toContain('长辈自己')
    expect(result.text).toContain('接电话、拍照')
    expect(result.text).toContain('字要大')
    // 结构化答案**原样**保留：前端按题还原问答记录，不靠解析那段文本
    expect(result.answers).toEqual([
      { id: 'goal', value: '长辈自己' },
      { id: 'topics', value: ['接电话', '拍照'] },
      { id: 'note', value: '字要大' },
    ])
  })

  it('给模型的那一份只有文本（结构化答案不进模型消息）', () => {
    const view = toModelOutput({
      text: '用户已回答：\n1. 这份剧本给谁看？\n   长辈自己',
      answers: [{ id: 'goal', value: '长辈自己' }],
    })
    expect(view).toEqual({
      type: 'text',
      value: '用户已回答：\n1. 这份剧本给谁看？\n   长辈自己',
    })
    expect(toModelOutput('兜底文本')).toEqual({ type: 'text', value: '兜底文本' })
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
