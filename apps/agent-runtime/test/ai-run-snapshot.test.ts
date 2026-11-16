import { describe, expect, it } from 'vitest'
import { encodeAgUiChunk, type AgUiChunk } from '@repo/shared'
import {
  buildRunSnapshot,
  decodeRecords,
  openPartChunks,
} from '../src/modules/ai/runtime/run-snapshot.js'
import { coalesceDeltas } from '../src/modules/ai/runtime/stream-resume.js'
import type { StreamRecord } from '../src/modules/ai/runtime/stream-store.service.js'

/**
 * 快照 + `sinceRev` 的归约口径（手册 §6.2）。
 *
 * 钉住三件事：
 * - 快照只含**已闭合 part**；
 * - `sinceRev` 指向最早未闭合 part 的 start 事件；
 * - 工具入参靠 ARGS 累积，结果到达时挂回同一张卡。
 */

const ctx = { threadId: 'conv-1', runId: 'run-1' }

/** chunk 序列 → 输出记录（每条事件一个递增 rev，与 runtime 的 append 口径一致） */
const recordsOf = (chunks: AgUiChunk[], startRev = 1): StreamRecord[] => {
  const records: StreamRecord[] = []
  let rev = startRev - 1
  for (const chunk of chunks) {
    for (const event of encodeAgUiChunk(chunk, ctx)) {
      rev += 1
      records.push({ rev, event })
    }
  }
  return records
}

describe('buildRunSnapshot', () => {
  it('空记录：rev = 0，不造假 part', () => {
    const { snapshot, replayChunks } = buildRunSnapshot('run-1', [])
    expect(snapshot).toEqual({
      runId: 'run-1',
      messageId: '',
      rev: 0,
      sinceRev: 0,
      parts: [],
    })
    expect(replayChunks).toEqual([])
  })

  it('只含已闭合 part：未闭合的 reasoning 从 sinceRev 接', () => {
    const records = recordsOf([
      { type: 'start', messageId: 'msg-1' },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: '已完成' },
      { type: 'text-end', id: 'text-1' },
      { type: 'reasoning-start', id: 'reason-1' },
      { type: 'reasoning-delta', id: 'reason-1', delta: '还在想' },
    ])
    const { snapshot, replayChunks } = buildRunSnapshot('run-1', records)

    expect(snapshot.messageId).toBe('msg-1')
    expect(snapshot.parts).toEqual([{ type: 'text', text: '已完成' }])
    // reasoning-start 是第 5 条事件 → sinceRev = 5；快照覆盖到 4
    expect(snapshot.sinceRev).toBe(5)
    expect(snapshot.rev).toBe(4)
    expect(replayChunks).toEqual([
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: '已完成' },
      { type: 'text-end', id: 'text-1' },
    ])
  })

  it('全部闭合：sinceRev = 最后一帧 + 1，快照就是全部内容', () => {
    const records = recordsOf([
      { type: 'text-start', id: 't', delta: '' },
      { type: 'text-delta', id: 't', delta: '你好' },
      { type: 'text-end', id: 't' },
      { type: 'data-run-usage', data: { usage: { totalTokens: 3 } } },
    ])
    const { snapshot } = buildRunSnapshot('run-1', records)

    expect(snapshot.sinceRev).toBe(5)
    expect(snapshot.rev).toBe(4)
    expect(snapshot.parts).toEqual([
      { type: 'text', text: '你好' },
      { type: 'data-run-usage', data: { usage: { totalTokens: 3 } } },
    ])
  })

  it('种子与增量按 part id 去重：时间线里已闭合、记录里仍打开的那段不再进种子', () => {
    // t0 已闭合；t1 还在流式（记录里没有 text-end）
    const records = recordsOf([
      { type: 'text-start', id: 't0' },
      { type: 'text-delta', id: 't0', delta: '第一段' },
      { type: 'text-end', id: 't0' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: '第二段' },
    ])
    // 时间线（DB）已经把 t1 落库了：两个数据源在这段上重叠
    const { snapshot } = buildRunSnapshot('run-1', records, {
      parts: [
        { type: 'text', text: '第一段', id: 't0' },
        { type: 'text', text: '第二段（DB 的完整版）', id: 't1' },
      ],
    })

    expect(snapshot.sinceRev).toBe(4)
    // t1 会在 rev 4 之后由增量补发 → 种子必须去掉它，否则同一段渲染两遍
    expect(snapshot.parts).toEqual([{ type: 'text', text: '第一段', id: 't0' }])
  })

  it('工具入参闭合在 sinceRev 前、结果在之后：种子必须保留工具卡', () => {
    const records = recordsOf([
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'bash' },
      { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{}' },
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'bash', input: {} },
      // 另一个未闭合 part：文本还在流 → sinceRev = 这一条
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: '还在流' },
      // 工具结果在增量里，只有 output、没有 input-start
      { type: 'tool-output-available', toolCallId: 'c1', output: { ok: true } },
    ])
    const { snapshot } = buildRunSnapshot('run-1', records, {
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'bash',
          toolCallId: 'c1',
          state: 'input-available',
          input: {},
        },
        { type: 'text', text: '还在流（DB 版本）', id: 't1' },
      ],
    })

    // 工具卡必须留在种子里（增量里没有创建它的 start）；文本交给增量
    expect(snapshot.parts).toEqual([
      {
        type: 'dynamic-tool',
        toolName: 'bash',
        toolCallId: 'c1',
        state: 'input-available',
        input: {},
      },
    ])
  })

  it('没有 id 的老行无法判定重叠：种子保留（兼容旧数据）', () => {
    const records = recordsOf([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: '在流式' },
    ])
    const { snapshot } = buildRunSnapshot('run-1', records, {
      parts: [{ type: 'text', text: '老时间线行（没有 id）' }],
    })
    expect(snapshot.parts).toEqual([{ type: 'text', text: '老时间线行（没有 id）' }])
  })

  it('工具卡：ARGS 累积成完整 input，结果挂回同一张卡', () => {
    const records = recordsOf([
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'bash' },
      { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"command":' },
      { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '"ls"}' },
      { type: 'tool-input-available', toolCallId: 'c1' },
      { type: 'tool-output-available', toolCallId: 'c1', output: { ok: true } },
    ])
    const { snapshot } = buildRunSnapshot('run-1', records)

    expect(snapshot.parts).toEqual([
      {
        type: 'dynamic-tool',
        toolName: 'bash',
        toolCallId: 'c1',
        state: 'output-available',
        input: { command: 'ls' },
        output: { ok: true },
      },
    ])
  })

  it('输出记录被裁剪：不补尾部（避免与时间线快照重复），并采用传入的 parts / messageId', () => {
    const records = recordsOf(
      [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: '裁剪后仍在流式' },
      ],
      100,
    )
    const { snapshot, replayChunks } = buildRunSnapshot('run-1', records, {
      messageId: 'msg-from-timeline',
      parts: [{ type: 'text', text: '时间线里的完整正文' }],
    })

    expect(snapshot.messageId).toBe('msg-from-timeline')
    // 最早能接上的位置 = 首条保留记录（未闭合 part 的 start 已不在窗口里）
    expect(snapshot.sinceRev).toBe(records[0]!.rev)
    expect(snapshot.rev).toBe(records[0]!.rev - 1)
    expect(snapshot.parts).toEqual([{ type: 'text', text: '时间线里的完整正文' }])
    expect(replayChunks[0]).toMatchObject({ type: 'text-start' })
  })

  it('读侧兼容旧记录：裸 chunk 也能归约', () => {
    const decoded = decodeRecords([
      { rev: 1, event: { type: 'text-start', id: 't' } },
      { rev: 2, event: { type: 'text-delta', id: 't', delta: '旧' } },
      { rev: 3, event: { type: 'text-end', id: 't' } },
    ])
    expect(decoded.map((item) => item.chunk.type)).toEqual(['text-start', 'text-delta', 'text-end'])
  })
})

describe('openPartChunks（裁剪后的尾部）', () => {
  it('只取仍未闭合的 part；已闭合的文本与 data-* 不重发', () => {
    const records = recordsOf(
      [
        { type: 'text-start', id: 'closed' },
        { type: 'text-delta', id: 'closed', delta: '已闭合' },
        { type: 'text-end', id: 'closed' },
        { type: 'text-start', id: 'open' },
        { type: 'text-delta', id: 'open', delta: '还在流' },
        { type: 'data-sub-agent-delta', data: { runId: 'sub-1', text: '子助手' } },
      ],
      100,
    )
    const out = openPartChunks(records)
    expect(out.map((chunk) => chunk.type)).toEqual(['text-start', 'text-delta'])
    expect(out.every((chunk) => chunk.id === 'open')).toBe(true)
  })

  it('start 被裁掉时，增量本身也算打开态（交给整形补 start）', () => {
    const records = recordsOf([{ type: 'text-delta', id: 'orphan', delta: '半截' }], 100)
    expect(openPartChunks(records)).toEqual([{ type: 'text-delta', id: 'orphan', delta: '半截' }])
  })
})

describe('coalesceDeltas', () => {
  it('相邻同 id 的增量合并，隔了别的块就不合并', () => {
    const merged = coalesceDeltas([
      { type: 'text-delta', id: 't', delta: 'a' },
      { type: 'text-delta', id: 't', delta: 'b' },
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'bash' },
      { type: 'text-delta', id: 't', delta: 'c' },
    ])
    expect(merged).toEqual([
      { type: 'text-delta', id: 't', delta: 'ab' },
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'bash' },
      { type: 'text-delta', id: 't', delta: 'c' },
    ])
  })

  it('工具入参增量也合并', () => {
    const merged = coalesceDeltas([
      { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"a":' },
      { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '1}' },
    ])
    expect(merged).toEqual([
      { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"a":1}' },
    ])
  })
})
