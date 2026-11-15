import { describe, expect, it, vi } from 'vitest'
import type { Response } from 'express'
import { AgentSseBridge } from '../src/agent/agent-sse.bridge.js'

const response = () => {
  const writes: string[] = []
  let ended = false
  const res = {
    writableEnded: false,
    write: (chunk: string) => {
      writes.push(chunk)
      return true
    },
    end: () => {
      ended = true
      res.writableEnded = true
    },
    on: () => undefined,
  } as unknown as Response & { writes: string[]; ended: boolean }
  Object.defineProperty(res, 'writes', { value: writes })
  Object.defineProperty(res, 'ended', { get: () => ended })
  return res
}

/** PubSub 替身：记录每个频道的处理函数，测试里直接投递 */
const makePubSub = () => {
  const handlers = new Map<string, (payload: unknown) => void>()
  const unsubscribe = vi.fn()
  return {
    handlers,
    unsubscribe,
    subscribeAsync: async (channel: string, handler: (payload: unknown) => void) => {
      handlers.set(channel, handler)
      return () => {
        handlers.delete(channel)
        unsubscribe()
      }
    },
  }
}

const silentLogger = {
  log: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}

const frame = (over: Record<string, unknown> = {}) => ({
  version: 1,
  runId: 'run-1',
  chunk: { type: 'text-delta', delta: 'hi' },
  final: false,
  createdAt: new Date().toISOString(),
  ...over,
})

const channelOf = (clientId: string): string => `agent:stream:client:${clientId}`

describe('AgentSseBridge（pub/sub → SSE）', () => {
  it('按 clientId 频道把 chunk 原样写成 SSE 帧', async () => {
    const pubsub = makePubSub()
    const bridge = new AgentSseBridge(pubsub as never, silentLogger as never)
    const res = response()
    await bridge.attach('client-1', res)
    expect(pubsub.handlers.has(channelOf('client-1'))).toBe(true)

    pubsub.handlers.get(channelOf('client-1'))?.(frame())
    expect(res.writes[0]).toBe('data: {"type":"text-delta","delta":"hi"}\n\n')
  })

  it('final 帧写 [DONE]、关闭连接并退订', async () => {
    const pubsub = makePubSub()
    const bridge = new AgentSseBridge(pubsub as never, silentLogger as never)
    const res = response()
    await bridge.attach('client-1', res)

    pubsub.handlers.get(channelOf('client-1'))?.(frame({ final: true }))
    expect(res.writes.at(-1)).toBe('data: [DONE]\n\n')
    expect(res.ended).toBe(true)
    expect(pubsub.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('deferred 期间先攒着，start() 后按序补出（补发完成再发响应头）', async () => {
    const pubsub = makePubSub()
    const bridge = new AgentSseBridge(pubsub as never, silentLogger as never)
    const res = response()
    await bridge.attach('client-1', res, true)

    const handler = pubsub.handlers.get(channelOf('client-1'))
    handler?.(frame({ chunk: { type: 'start' } }))
    handler?.(frame({ chunk: { type: 'text-delta', delta: 'a' } }))
    expect(res.writes).toHaveLength(0)

    bridge.start('client-1')
    expect(res.writes).toEqual([
      'data: {"type":"start"}\n\n',
      'data: {"type":"text-delta","delta":"a"}\n\n',
    ])
  })

  it('非法帧直接丢弃（不写坏 SSE）', async () => {
    const pubsub = makePubSub()
    const bridge = new AgentSseBridge(pubsub as never, silentLogger as never)
    const res = response()
    await bridge.attach('client-1', res)

    pubsub.handlers.get(channelOf('client-1'))?.({ nope: true })
    expect(res.writes).toHaveLength(0)
  })
})
