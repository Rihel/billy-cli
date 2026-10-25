import { describe, expect, it } from 'vitest'
import { isAnswered, questionsOf } from '../src/app/(standalone)/main/ai/chat/question-card'

describe('isAnswered', () => {
  const base = { id: 'q1', title: '给谁看？' }

  it('文本 / 单选：去掉空白后非空才算答过', () => {
    expect(isAnswered({ ...base, type: 'text' }, '   ')).toBe(false)
    expect(isAnswered({ ...base, type: 'text' }, undefined)).toBe(false)
    expect(isAnswered({ ...base, type: 'single' }, '长辈')).toBe(true)
  })

  it('多选：勾了至少一项才算答过', () => {
    expect(isAnswered({ ...base, type: 'multi' }, [])).toBe(false)
    expect(isAnswered({ ...base, type: 'multi' }, ['接电话'])).toBe(true)
  })
})

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
