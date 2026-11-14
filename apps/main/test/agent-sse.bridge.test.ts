import { describe, expect, it } from 'vitest'
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

const event = (over: Record<string, unknown> = {}) => ({
  version: 1,
  clientId: 'client-1',
  runId: 'run-1',
  conversationId: 'conv-1',
  ownerId: 'user-1',
  chunk: { type: 'text-delta', delta: 'hi' },
  final: false,
  createdAt: new Date().toISOString(),
  ...over,
})

describe('AgentSseBridge（Kafka → SSE）', () => {
  it('按 clientId 把 chunk 原样写成 SSE 帧', () => {
    const bridge = new AgentSseBridge()
    const res = response()
    bridge.attach('client-1', res)
    bridge.onEvent(event())
    expect(res.writes[0]).toBe('data: {"type":"text-delta","delta":"hi"}\n\n')
  })

  it('final 事件写 [DONE] 并关闭连接', () => {
    const bridge = new AgentSseBridge()
    const res = response()
    bridge.attach('client-1', res)
    bridge.onEvent(event({ final: true }))
    expect(res.writes.at(-1)).toBe('data: [DONE]\n\n')
    expect(res.writableEnded).toBe(true)
  })
})
