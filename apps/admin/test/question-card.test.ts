import { describe, expect, it } from 'vitest'
import { questionsOf } from '../src/app/(standalone)/main/ai/chat/question-card'

describe('questionsOf', () => {
  it('批量问题：原样取 questions', () => {
    const questions = questionsOf({
      suspendPayload: {
        questions: [
          { id: 'audience', type: 'single', title: '给谁看？', options: [{ label: '自己' }] },
        ],
      },
    })
    expect(questions).toHaveLength(1)
    expect(questions[0]?.type).toBe('single')
  })

  it('Mastra 内置 ask_user 的单问题 payload 也能降级成一道题', () => {
    const questions = questionsOf({
      suspendPayload: {
        question: '先教哪一件？',
        options: [{ label: '接电话' }, { label: '发微信' }],
        selectionMode: 'multi_select',
      },
    })
    expect(questions).toEqual([
      {
        id: 'q1',
        type: 'multi',
        title: '先教哪一件？',
        options: [{ label: '接电话' }, { label: '发微信' }],
        required: true,
      },
    ])
  })

  it('认不出的 payload 返回空数组，由上层兜底', () => {
    expect(questionsOf({ suspendPayload: {} })).toEqual([])
    expect(questionsOf(undefined)).toEqual([])
  })
})
