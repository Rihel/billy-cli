import { describe, expect, it } from 'vitest'
import { StreamRecorder } from '../src/modules/ai/runtime/stream-recorder.js'
import type { ToolCallMetaStore } from '../src/modules/ai/core/tools/tool.meta.js'
import type { TimelineRepository } from '../src/modules/ai/runtime/timeline.repository.js'

/**
 * 录制器的观测口径（2026-10-29 补齐）。
 *
 * 钉住四件事：
 * 1. **首 token 时间**能被量到（`firstOutputAtMs` 非空）—— 以前这个数根本不存在，
 *    `runs.first_token_ms` 永远是 null；
 * 2. **步耗时**从 `start-step` / `finish-step` 的时间差落进 `duration_ms`；
 * 3. **工具耗时**从网关旁证（`meta.durationMs`）落进列，而不是只留在 `payload.outcome`；
 * 4. **失败口径**：拒绝按原因落 `denied` / `invalid`，工具把失败当结果返回（`ok:false`）也算 `output-error`。
 */
const collect = (meta?: Record<string, unknown>) => {
  const rows: Array<Record<string, unknown>> = []
  const timelines = {
    append: async (data: Record<string, unknown>) => {
      rows.push(data)
      return data
    },
  } as unknown as TimelineRepository
  const metas = meta
    ? ({ take: () => meta } as unknown as ToolCallMetaStore)
    : undefined
  const recorder = new StreamRecorder(
    timelines,
    { conversationId: 'c1', runId: 'r1' } as never,
    metas ? { metas, isKnownTool: () => true } : {},
  )
  return { rows, recorder }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('StreamRecorder：观测字段', () => {
  it('首 token 时间：第一次文本增量时记录，只记一次', async () => {
    const { recorder } = collect()
    await recorder.consume({ type: 'start-step' } as never)
    expect(recorder.firstOutputAtMs).toBeNull()

    await recorder.consume({ type: 'text-delta', id: 't1', delta: '你' } as never)
    const first = recorder.firstOutputAtMs
    expect(first).not.toBeNull()

    await sleep(5)
    await recorder.consume({ type: 'text-delta', id: 't1', delta: '好' } as never)
    expect(recorder.firstOutputAtMs).toBe(first)
  })

  it('步耗时：start-step → finish-step 的时间差落到步行的 duration_ms', async () => {
    const { rows, recorder } = collect()
    await recorder.consume({ type: 'start-step' } as never)
    await sleep(5)
    await recorder.consume({ type: 'finish-step' } as never)
    await recorder.finish([{ finishReason: 'stop' }])

    const step = rows.find((row) => row.kind === 'step')
    expect(step).toBeDefined()
    expect(typeof step?.durationMs).toBe('number')
    expect(step?.durationMs as number).toBeGreaterThanOrEqual(4)
    // 拿不到时长的步不写 0（不编造）
    const { rows: rows2, recorder: recorder2 } = collect()
    await recorder2.finish([{ finishReason: 'stop' }])
    expect(rows2.find((row) => row.kind === 'step')?.durationMs).toBeUndefined()
  })

  it('工具耗时：从网关旁证取 durationMs 落到列，出参仍全量入库', async () => {
    const { rows, recorder } = collect({ ok: true, durationMs: 123, configVersion: 'v1' })
    await recorder.consume({
      type: 'tool-input-available',
      toolCallId: 'call-1',
      toolName: 'demo',
      input: { a: 1 },
    } as never)
    await recorder.consume({
      type: 'tool-output-available',
      toolCallId: 'call-1',
      output: { big: 'x'.repeat(50) },
    } as never)

    const result = rows.find((row) => row.kind === 'tool-result')
    expect(result?.durationMs).toBe(123)
    expect(result?.payload).toMatchObject({
      output: { big: 'x'.repeat(50) },
      isError: false,
    })
    expect(result?.payload).toMatchObject({ outcome: { durationMs: 123 } })
  })

  it('拒绝按原因分桶：限流 / 关闭 / 无权限 / 前置条件不满足 → denied', async () => {
    for (const reason of ['rate-limited', 'disabled', 'forbidden', 'precheck-failed']) {
      const { rows, recorder } = collect({ ok: false, reason, configVersion: 'v1', durationMs: 3 })
      await recorder.consume({ type: 'tool-input-available', toolCallId: 'c', toolName: 'demo' } as never)
      await recorder.consume({ type: 'tool-output-error', toolCallId: 'c', errorText: '被拒' } as never)
      const result = rows.find((row) => row.kind === 'tool-result')
      expect(result?.state).toBe('denied')
    }
  })

  it('入参不合法 → invalid；未知工具 → unknown-tool', async () => {
    const invalid = collect({ ok: false, reason: 'invalid-input', configVersion: 'v1', durationMs: 1 })
    await invalid.recorder.consume({ type: 'tool-input-available', toolCallId: 'c', toolName: 'demo' } as never)
    await invalid.recorder.consume({ type: 'tool-output-error', toolCallId: 'c', errorText: '入参错' } as never)
    expect(invalid.rows.find((row) => row.kind === 'tool-result')?.state).toBe('invalid')

    const unknown: string[] = []
    const timelines = {
      append: async (data: Record<string, unknown>) => {
        if (data.kind === 'tool-result') unknown.push(String(data.state))
        return data
      },
    } as unknown as TimelineRepository
    const recorder = new StreamRecorder(timelines, { conversationId: 'c1', runId: 'r1' }, {
      isKnownTool: () => false,
    })
    await recorder.consume({ type: 'tool-output-error', toolCallId: 'c', toolName: 'made-up' } as never)
    expect(unknown).toEqual(['unknown-tool'])
  })

  it('工具把失败当结果返回（ok:false）：落 output-error + isError，并保留完整出参', async () => {
    const { rows, recorder } = collect()
    await recorder.consume({ type: 'tool-input-available', toolCallId: 'c', toolName: 'scene-save' } as never)
    await recorder.consume({
      type: 'tool-output-available',
      toolCallId: 'c',
      output: { ok: false, reason: '没有第 3 章', detail: 'x'.repeat(200) },
    } as never)

    const result = rows.find((row) => row.kind === 'tool-result')
    expect(result?.state).toBe('output-error')
    expect(result?.payload).toMatchObject({ isError: true, dataFailure: '没有第 3 章' })
    // 出参全量入库（模型确实收到了这份数据，审计要能对上）
    expect((result?.payload as { output: { detail: string } }).output.detail).toHaveLength(200)
  })

  it('正常结果（ok:true 或没有 ok 字段）仍是 output-available', async () => {
    const { rows, recorder } = collect()
    await recorder.consume({ type: 'tool-input-available', toolCallId: 'c', toolName: 'demo' } as never)
    await recorder.consume({
      type: 'tool-output-available',
      toolCallId: 'c',
      output: { ok: true, data: 1 },
    } as never)
    expect(rows.find((row) => row.kind === 'tool-result')?.state).toBe('output-available')
  })
})
