import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import {
  RunActivity,
  runActivityText,
} from '../src/app/(app)/(standalone)/main/ai/chat/run-activity.tsx'

/**
 * 时间线底部的运行指示：文案判据 + SSR 冒烟。
 *
 * 要钉住两条：
 * 1. 文案来自**既有数据**（`status` + 最后一条消息的 parts），且永远是"最靠后发生的那件事"；
 * 2. 已经收尾的工具（有出参）**不算**信号 —— 它后面还有正文 / 下一轮推理时不能停留在"正在调用"。
 */

const message = (parts: unknown[]): UIMessage =>
  ({ id: 'm1', role: 'assistant', parts }) as unknown as UIMessage

const tool = (state: string, name = 'bash') => ({
  type: `tool-${name}`,
  toolCallId: 'c1',
  state,
  input: {},
})

const subAgent = (overrides: Record<string, unknown>) => ({
  type: 'data-sub-agent',
  id: 'sub1',
  data: { runId: 'sub1', name: '北美欧洲线', ...overrides },
})

describe('runActivityText', () => {
  it('刚发出（submitted）→ 正在准备', () => {
    expect(runActivityText([], 'submitted')).toBe('正在准备…')
  })

  it('工具入参就绪 → 正在调用（带工具名）；入参还在流 → 正在准备调用', () => {
    expect(runActivityText([message([tool('input-available')])], 'streaming')).toBe(
      '正在调用 bash…',
    )
    expect(runActivityText([message([tool('input-streaming')])], 'streaming')).toBe(
      '正在准备调用 bash…',
    )
  })

  it('推理在流 → 正在思考；正文在流 → 正在输出', () => {
    expect(
      runActivityText(
        [message([{ type: 'reasoning', text: '想想', state: 'streaming' }])],
        'streaming',
      ),
    ).toBe('正在思考…')
    expect(runActivityText([message([{ type: 'text', text: '答案' }])], 'streaming')).toBe(
      '正在输出…',
    )
  })

  it('子助手在跑 → 报子助手的名字（主 agent 此刻在等它）', () => {
    expect(runActivityText([message([subAgent({ status: 'running' })])], 'streaming')).toBe(
      '子助手「北美欧洲线」正在干活…',
    )
    // 状态块被工具事件覆盖（真实流形态）时同样算在跑
    expect(
      runActivityText([message([subAgent({ event: { kind: 'tool-call' } })])], 'streaming'),
    ).toBe('子助手「北美欧洲线」正在干活…')
    expect(
      runActivityText([message([subAgent({ status: 'succeeded', result: 'ok' })])], 'streaming'),
    ).toBe('正在思考…')
  })

  /**
   * 2026-11-24 上游 issue（fork 报障）：父轮先收尾、子助手后完成时，终态块没赶上父流，
   * 消息里的 part 冻在起跑快照；唤醒轮 store 已清空实时数据，兜底若只扫 parts 就会一直报
   * 「正在干活」。判活前必须拿库内已终态对账。
   */
  it('parts 冻在起跑快照、库内已终态 → 不再报子助手在干活', () => {
    expect(
      runActivityText(
        [message([subAgent({ status: 'running' }), { type: 'text', text: '汇总如下' }])],
        'streaming',
        null,
        new Set(['sub1']),
      ),
    ).toBe('正在输出…')
  })

  it('parts 冻在无 status 的工具事件块、库内已终态 → 同样不算活跃', () => {
    expect(
      runActivityText(
        [message([subAgent({ event: { kind: 'tool-call' } }), { type: 'text', text: '汇总如下' }])],
        'streaming',
        null,
        new Set(['sub1']),
      ),
    ).toBe('正在输出…')
  })

  it('库内还没认识这个子 run（刚起跑窗口）→ 仍按 parts 判活跃', () => {
    expect(
      runActivityText([message([subAgent({ status: 'running' })])], 'streaming', null, new Set()),
    ).toBe('子助手「北美欧洲线」正在干活…')
  })

  it('收尾的工具不算信号：它后面有正文就报"正在输出"，什么都没有就报"正在思考"', () => {
    expect(
      runActivityText(
        [message([tool('output-available'), { type: 'text', text: '汇总如下' }])],
        'streaming',
      ),
    ).toBe('正在输出…')
    expect(runActivityText([message([tool('output-available')])], 'streaming')).toBe('正在思考…')
  })

  it('parts 还是空的（流刚建立）→ 正在思考，不显示空白', () => {
    expect(runActivityText([message([])], 'streaming')).toBe('正在思考…')
  })

  it('没有任何子助手时：走通用状态，指示里**不出现**"子助手"字样', () => {
    const text = runActivityText(
      [message([tool('output-available'), { type: 'text', text: '在写了' }])],
      'streaming',
    )

    expect(text).toBe('正在输出…')
    expect(text).not.toContain('子助手')
  })

  it('一轮结束后（status 回到 ready / error）→ 返回 null，指示消失（不留残影）', () => {
    const finished = [message([subAgent({ status: 'succeeded', result: 'ok' })])]

    expect(runActivityText(finished, 'ready')).toBeNull()
    expect(runActivityText(finished, 'error')).toBeNull()
  })
})

describe('RunActivity', () => {
  it('渲染转圈 + 当前状态文案（固定高度，不把时间线顶跳）', () => {
    const html = renderToStaticMarkup(
      createElement(RunActivity, {
        messages: [message([tool('input-available')])],
        status: 'streaming',
      }),
    )

    expect(html).toContain('animate-spin')
    expect(html).toContain('正在调用 bash…')
    expect(html).toContain('role="status"')
    expect(html).toContain('h-6')
  })

  it('子助手活动结束后（status=ready）**不渲染任何东西**；子助手跑完但主 agent 还在跑时只报通用状态', () => {
    const finished = [message([subAgent({ status: 'succeeded', result: 'ok' })])]
    expect(
      renderToStaticMarkup(createElement(RunActivity, { messages: finished, status: 'ready' })),
    ).toBe('')

    const stillWorking = renderToStaticMarkup(
      createElement(RunActivity, { messages: finished, status: 'streaming' }),
    )
    expect(stillWorking).toContain('role="status"')
    expect(stillWorking).toContain('正在思考…')
    expect(stillWorking).not.toContain('正在干活')
  })

  it('把 settledRunIds 传给文案判据：已终态子 run 不再报"正在干活"', () => {
    const html = renderToStaticMarkup(
      createElement(RunActivity, {
        messages: [message([subAgent({ status: 'running' })])],
        status: 'streaming',
        settledRunIds: new Set(['sub1']),
      }),
    )
    expect(html).toContain('正在思考…')
    expect(html).not.toContain('正在干活')
  })
})
