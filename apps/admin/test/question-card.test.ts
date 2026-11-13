import { describe, expect, it } from 'vitest'
import {
  OTHER_OPTION,
  isAnswered,
  questionsOf,
  resolveAnswerValue,
} from '../src/app/(app)/(standalone)/main/ai/chat/question-card'

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

describe('resolveAnswerValue（选项之外的兜底输入）', () => {
  const single = { id: 'q1', title: '给谁看？', type: 'single' as const }
  const multi = { id: 'q2', title: '哪些场景？', type: 'multi' as const }

  it('单选：选普通项时答案就是 label，选了「其他」才用输入框文字', () => {
    expect(resolveAnswerValue(single, '长辈', '')).toBe('长辈')
    expect(resolveAnswerValue(single, OTHER_OPTION, '  都给  ')).toBe('都给')
  })

  it('单选：选了「其他」却没写 → 空串（必答题据此拦「下一题」，不会把空答案交上去）', () => {
    const value = resolveAnswerValue(single, OTHER_OPTION, '   ')
    expect(value).toBe('')
    expect(isAnswered(single, value)).toBe(false)
  })

  it('多选：勾选项 + 自定义文本合成一个数组，哨兵值不外泄', () => {
    expect(resolveAnswerValue(multi, ['接电话', OTHER_OPTION], '开车时')).toEqual([
      '接电话',
      '开车时',
    ])
    expect(resolveAnswerValue(multi, ['接电话'], '写了但没勾无效果')).toEqual(['接电话'])
    expect(resolveAnswerValue(multi, [OTHER_OPTION], '   ')).toEqual([])
  })

  it('问答：文本原样返回（它本身就是输入框）', () => {
    expect(resolveAnswerValue({ id: 'q3', title: '详细说', type: 'text' }, '随便写', '')).toBe(
      '随便写',
    )
    expect(resolveAnswerValue({ id: 'q3', title: '详细说', type: 'text' }, undefined, '')).toBe('')
  })
})
