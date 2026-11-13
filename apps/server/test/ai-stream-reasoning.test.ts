import { describe, expect, it } from 'vitest'
import { reasoningSafeTransform, type UiChunk } from '../src/modules/ai/mastra/stream.adapter.js'

/**
 * 前端 500 的根因：AI SDK 的 UI Message Stream 收到 `reasoning-delta` 时，
 * 如果前面没有 `reasoning-start`，会直接抛
 * `Received reasoning-delta for missing reasoning part with ID "reasoning-0"`。
 *
 * 有些提供方（DeepSeek 的 `reasoning_content`）只发增量、不发开始标记。
 * 这里钉住适配器的兜底：只来 delta 也要补 start；start / end 要成对；
 * 一段思考结束后再来增量，必须换新 id。
 */
async function run(input: UiChunk[]): Promise<UiChunk[]> {
  const source = new ReadableStream<UiChunk>({
    start(controller) {
      input.forEach((chunk) => controller.enqueue(chunk))
      controller.close()
    },
  })
  const reader = source.pipeThrough(reasoningSafeTransform()).getReader()
  const out: UiChunk[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out.push(value)
  }
  return out
}

const types = (chunks: UiChunk[]) => chunks.map((chunk) => chunk.type)

describe('reasoningSafeTransform：思考块必须 start 在前', () => {
  it('只有 delta 的提供方：自动补 start，并在流结束时补 end', async () => {
    const out = await run([{ type: 'reasoning-delta', id: 'reasoning-0', delta: '我在想…' }])

    expect(types(out)).toEqual(['reasoning-start', 'reasoning-delta', 'reasoning-end'])
    expect(out.every((chunk) => chunk.id === 'reasoning-0')).toBe(true)
    expect(out[1]?.delta).toBe('我在想…')
  })

  it('正常的 start → delta → end：原样成对，不重复插 start', async () => {
    const out = await run([
      { type: 'reasoning-start', id: 'r-1' },
      { type: 'reasoning-delta', id: 'r-1', delta: '第一段' },
      { type: 'reasoning-delta', id: 'r-1', delta: '第二段' },
      { type: 'reasoning-end', id: 'r-1' },
    ])

    expect(types(out)).toEqual([
      'reasoning-start',
      'reasoning-delta',
      'reasoning-delta',
      'reasoning-end',
    ])
    expect(new Set(out.map((chunk) => chunk.id)).size).toBe(1)
  })

  it('重复的 start 只留一个', async () => {
    const out = await run([
      { type: 'reasoning-start', id: 'r-1' },
      { type: 'reasoning-start', id: 'r-1' },
      { type: 'reasoning-delta', id: 'r-1', delta: '一段' },
    ])

    expect(types(out).filter((type) => type === 'reasoning-start')).toHaveLength(1)
  })

  it('答案开始输出前先收口思考（text-start 之前必须有 reasoning-end）', async () => {
    const out = await run([
      { type: 'reasoning-delta', id: 'r-1', delta: '先想一下' },
      { type: 'text-start', id: 't-1' },
      { type: 'text-delta', id: 't-1', delta: '答案' },
    ])

    expect(types(out)).toEqual([
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'text-start',
      'text-delta',
    ])
  })

  it('同一段思考结束后又来增量：换新 id，不复用旧 part', async () => {
    const out = await run([
      { type: 'reasoning-delta', id: 'r-1', delta: '第一段' },
      { type: 'reasoning-end', id: 'r-1' },
      { type: 'reasoning-delta', id: 'r-1', delta: '第二段' },
    ])

    expect(types(out)).toEqual([
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
    ])
    expect(out[0]?.id).not.toBe(out[3]?.id)
  })

  it('start 不带 id、delta 才带：算同一段，不拆成两块', async () => {
    const out = await run([
      { type: 'reasoning-start' },
      { type: 'reasoning-delta', id: 'reasoning-0', delta: '我在想…' },
    ])

    expect(types(out)).toEqual(['reasoning-start', 'reasoning-delta', 'reasoning-end'])
    expect(new Set(out.map((chunk) => chunk.id)).size).toBe(1)
  })

  it('普通片段原样透传，不被加料', async () => {
    const out = await run([
      { type: 'start-step' },
      { type: 'text-delta', id: 't-1', delta: '你好' },
      { type: 'finish' },
    ])

    expect(types(out)).toEqual(['start-step', 'text-delta', 'finish'])
  })
})
