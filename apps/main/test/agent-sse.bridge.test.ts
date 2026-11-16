import { describe, expect, it, vi } from 'vitest'
import type { Response } from 'express'
import { AgentSseBridge } from '../src/agent/agent-sse.bridge.js'

/**
 * 网关出口的两套协议（2026-11-17 迁移 AG-UI 后重写）。
 *
 * 钉住的是**出口契约**：
 * - 默认 `agui`：事件原样透传，收尾是 `RUN_FINISHED` + `end()`，**不写 `[DONE]`**；
 * - 回退 `ai`：事件逆映射回旧 chunk，收尾仍写 `[DONE]`（老前端零改动）；
 * - 只认 `RUN_FINISHED` / 旧结束标记判定收尾，不能只看 `frame.final`。
 */

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

const frame = (event: unknown, over: Record<string, unknown> = {}) => ({
  version: 2,
  runId: 'run-1',
  event,
  final: false,
  createdAt: new Date().toISOString(),
  ...over,
})

const channelOf = (clientId: string): string => `agent:stream:client:${clientId}`

const deliver = (pubsub: ReturnType<typeof makePubSub>, clientId: string, payload: unknown) => {
  pubsub.handlers.get(channelOf(clientId))?.(payload)
}

describe('AgentSseBridge（pub/sub → SSE）', () => {
  it('默认 agui：事件原样写成 SSE 帧', async () => {
    const pubsub = makePubSub()
    const bridge = new AgentSseBridge(pubsub as never, silentLogger as never)
    const res = response()
    await bridge.attach('client-1', res)
    expect(pubsub.handlers.has(channelOf('client-1'))).toBe(true)

    const event = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'hi' }
    deliver(pubsub, 'client-1', frame(event))

    expect(res.writes[0]).toBe(`data: ${JSON.stringify(event)}\n\n`)
  })

  it('RUN_FINISHED 收尾：不写 [DONE]，直接 end 并退订', async () => {
    const pubsub = makePubSub()
    const bridge = new AgentSseBridge(pubsub as never, silentLogger as never)
    const res = response()
    await bridge.attach('client-1', res)

    const event = { type: 'RUN_FINISHED', threadId: 't', runId: 'run-1' }
    // 故意不置 frame.final：收尾必须由事件本身判定
    deliver(pubsub, 'client-1', frame(event))

    expect(res.writes.at(-1)).toBe(`data: ${JSON.stringify(event)}\n\n`)
    expect(res.writes.join('')).not.toContain('[DONE]')
    expect(res.ended).toBe(true)
    expect(pubsub.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('deferred 期间先攒着，start() 后按序补出（补发完成再发响应头）', async () => {
    const pubsub = makePubSub()
    const bridge = new AgentSseBridge(pubsub as never, silentLogger as never)
    const res = response()
    await bridge.attach('client-1', res, { deferred: true })

    const message = { type: 'CUSTOM', name: 'agent.message', value: { messageId: 'm' } }
    const text = { type: 'TEXT_MESSAGE_CONTENT', messageId: 't', delta: 'a' }
    deliver(pubsub, 'client-1', frame(message))
    deliver(pubsub, 'client-1', frame(text))
    expect(res.writes).toHaveLength(0)

    bridge.start('client-1')
    expect(res.writes).toEqual([
      `data: ${JSON.stringify(message)}\n\n`,
      `data: ${JSON.stringify(text)}\n\n`,
    ])
  })

  it('回退口 protocol=ai：事件逆映射成 chunk，收尾写 [DONE]', async () => {
    const pubsub = makePubSub()
    const bridge = new AgentSseBridge(pubsub as never, silentLogger as never)
    const res = response()
    await bridge.attach('client-1', res, { protocol: 'ai' })

    deliver(
      pubsub,
      'client-1',
      frame({ type: 'TEXT_MESSAGE_CONTENT', messageId: 't', delta: 'hi' }),
    )
    expect(res.writes[0]).toBe('data: {"type":"text-delta","id":"t","delta":"hi"}\n\n')

    deliver(pubsub, 'client-1', frame({ type: 'RUN_FINISHED', threadId: 't', runId: 'run-1' }))
    expect(res.writes.at(-1)).toBe('data: [DONE]\n\n')
    expect(res.ended).toBe(true)
  })

  it('旧记录（裸 chunk）在 agui 出口现场编码，不把 chunk 直接写出去', async () => {
    const pubsub = makePubSub()
    const bridge = new AgentSseBridge(pubsub as never, silentLogger as never)
    const res = response()
    await bridge.attach('client-1', res)

    deliver(pubsub, 'client-1', frame({ type: 'text-delta', id: 't', delta: '旧记录' }))

    const parsed = JSON.parse(res.writes[0]!.slice('data: '.length)) as Record<string, unknown>
    expect(parsed).toMatchObject({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 't',
      delta: '旧记录',
    })
  })

  it('非法帧直接丢弃（不写坏 SSE）', async () => {
    const pubsub = makePubSub()
    const bridge = new AgentSseBridge(pubsub as never, silentLogger as never)
    const res = response()
    await bridge.attach('client-1', res)

    deliver(pubsub, 'client-1', { nope: true })
    expect(res.writes).toHaveLength(0)
  })
})
