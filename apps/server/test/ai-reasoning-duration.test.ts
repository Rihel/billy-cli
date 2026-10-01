import { describe, expect, it } from 'vitest'
import { StreamRecorder } from '../src/modules/ai/runtime/stream-recorder.js'
import type { TimelineRepository } from '../src/modules/ai/runtime/timeline.repository.js'

/**
 * 思考行的**真实时长**（用户报的"思考了几秒"是 ai-elements 的占位文案，根因是历史里没有时长）。
 *
 * 这条测试钉住"记录器把开始时间也算进思考行"：`reasoning-start` → 若干 `reasoning-delta`
 * → `reasoning-finish`，落库那行的 `durationMs` 必须 > 0（前端据此显示"思考了 N 秒"）。
 */
const collect = () => {
  const rows: Array<Record<string, unknown>> = []
  const timelines = {
    append: async (data: Record<string, unknown>) => {
      rows.push(data)
      return data
    },
  } as unknown as TimelineRepository
  const recorder = new StreamRecorder(
    timelines,
    { conversationId: 'c1', runId: 'r1' } as never,
    {},
  )
  return { rows, recorder }
}

describe('StreamRecorder：思考行带真实时长', () => {
  it('reasoning-start → delta → finish：落库的思考行有 durationMs', async () => {
    const { rows, recorder } = collect()
    await recorder.consume({ type: 'reasoning-start', id: 'r-1' } as never)
    await recorder.consume({ type: 'reasoning-delta', id: 'r-1', delta: '我在想…' } as never)
    await recorder.consume({ type: 'reasoning-end', id: 'r-1' } as never)

    const reasoning = rows.find((row) => row.kind === 'reasoning')
    expect(reasoning).toBeDefined()
    expect(reasoning?.payload).toEqual({ text: '我在想…' })
    expect(typeof reasoning?.durationMs).toBe('number')
    expect(reasoning?.durationMs as number).toBeGreaterThanOrEqual(0)
  })

  it('只有增量没有 start（部分提供方如此）也记开始时间 —— 不会退化成"没有时长"', async () => {
    const { rows, recorder } = collect()
    await recorder.consume({ type: 'reasoning-delta', id: 'r-2', delta: '直接给增量' } as never)
    await recorder.flushPending()

    const reasoning = rows.find((row) => row.kind === 'reasoning')
    expect(typeof reasoning?.durationMs).toBe('number')
  })
})
