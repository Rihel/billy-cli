import { describe, expect, it } from 'vitest';
import { resumeSafeChunks } from '../src/modules/ai/runtime/stream-resume.js';

const types = (chunks: Array<{ type?: string }>): Array<string | undefined> =>
  chunks.map((chunk) => chunk.type);

/**
 * 断线重连的 offset 可能落在块中间。AI SDK 的 UI 状态机会在
 * `reasoning-delta` / `text-delta` 找不到对应 start 时直接抛错，
 * 所以补发前必须把起点回退到块开头（或补 start）。
 */
describe('resumeSafeChunks：补发不能从块中间开始', () => {
  it('offset 落在 reasoning 中间：回退到 reasoning-start，并补回消息 start', () => {
    const all = [
      { type: 'start', messageId: 'm-1' },
      { type: 'reasoning-start', id: 'reasoning-2' },
      { type: 'reasoning-delta', id: 'reasoning-2', delta: '第一段' },
      { type: 'reasoning-delta', id: 'reasoning-2', delta: '第二段' },
    ]

    const out = resumeSafeChunks(all, 2)

    expect(types(out)).toEqual([
      'start',
      'reasoning-start',
      'reasoning-delta',
      'reasoning-delta',
    ])
    expect(out.filter((chunk) => chunk.type === 'reasoning-start')).toHaveLength(1)
  })

  it('offset 正好在 reasoning-start：不重复插 start', () => {
    const all = [
      { type: 'start', messageId: 'm-1' },
      { type: 'reasoning-start', id: 'r-1' },
      { type: 'reasoning-delta', id: 'r-1', delta: '想' },
    ]

    const out = resumeSafeChunks(all, 1)

    expect(types(out)).toEqual(['start', 'reasoning-start', 'reasoning-delta'])
  })

  it('记录被截断、找不到 reasoning-start：补一个合成 start', () => {
    const all = [{ type: 'reasoning-delta', id: 'reasoning-2', delta: '后半段' }]

    const out = resumeSafeChunks(all, 0)

    expect(types(out)).toEqual(['reasoning-start', 'reasoning-delta'])
    expect(out[0]).toMatchObject({ id: 'reasoning-2' })
  })

  it('孤立的 reasoning-end 直接丢弃，不让 UI 报 missing part', () => {
    const all = [{ type: 'reasoning-end', id: 'reasoning-2' }]

    expect(resumeSafeChunks(all, 0)).toEqual([])
  })

  it('offset 落在 text 中间：回退到 text-start', () => {
    const all = [
      { type: 'start', messageId: 'm-1' },
      { type: 'text-start', id: 't-1' },
      { type: 'text-delta', id: 't-1', delta: '你' },
      { type: 'text-delta', id: 't-1', delta: '好' },
    ]

    const out = resumeSafeChunks(all, 2)

    expect(types(out)).toEqual(['start', 'text-start', 'text-delta', 'text-delta'])
  })

  it('offset 落在 tool-input 中间：回退到 tool-input-start', () => {
    const all = [
      { type: 'start', messageId: 'm-1' },
      { type: 'tool-input-start', id: 'call-1' },
      { type: 'tool-input-delta', id: 'call-1', delta: '{"q":' },
    ]

    const out = resumeSafeChunks(all, 2)

    expect(types(out)).toEqual(['start', 'tool-input-start', 'tool-input-delta'])
  })

  it('offset 落在 tool output：把对应的 tool-input-available 补回来', () => {
    const all = [
      { type: 'start', messageId: 'm-1' },
      {
        type: 'tool-input-available',
        toolCallId: 'call_01',
        toolName: 'run-sub-agent',
        input: { name: 'x' },
      },
      { type: 'tool-output-available', toolCallId: 'call_01', output: { ok: true } },
    ]

    const out = resumeSafeChunks(all, 3)
    expect(types(out)).toEqual(['start', 'tool-input-available', 'tool-output-available'])
  })

  it('offset 只有孤立的 tool output：丢弃，避免 No tool invocation found', () => {
    const all = [
      { type: 'start', messageId: 'm-1' },
      { type: 'tool-output-available', toolCallId: 'call_01', output: { ok: true } },
    ]

    expect(types(resumeSafeChunks(all, 1))).toEqual(['start'])
  })

  it('offset 正好等于长度、最后一块仍在流式：回退到块开头', () => {
    const all = [
      { type: 'start', messageId: 'm-1' },
      { type: 'reasoning-start', id: 'reasoning-2' },
      { type: 'reasoning-delta', id: 'reasoning-2', delta: '想' },
    ]

    const out = resumeSafeChunks(all, 3)

    expect(types(out)).toEqual(['start', 'reasoning-start', 'reasoning-delta'])
  })

  it('offset 正好等于长度、最后一块已结束：不补发旧块', () => {
    const all = [
      { type: 'start', messageId: 'm-1' },
      { type: 'reasoning-start', id: 'reasoning-2' },
      { type: 'reasoning-delta', id: 'reasoning-2', delta: '想' },
      { type: 'reasoning-end', id: 'reasoning-2' },
    ]

    expect(resumeSafeChunks(all, 4)).toEqual([])
  })

  it('offset 超出已有片段：返回空，等实时流', () => {
    expect(resumeSafeChunks([{ type: 'start' }], 9)).toEqual([])
  })
});
