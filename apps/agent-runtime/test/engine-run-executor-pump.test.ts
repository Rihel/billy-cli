import { describe, expect, it, vi } from 'vitest'
import { RunExecutor } from '../src/modules/ai/engine/run-executor.js'
import type { StreamResponseLike } from '../src/modules/ai/runtime/stream/stream-response.js'
import type { RunEntity } from '@repo/db'

const caller = { id: 'user_1', isAdmin: false }
const input = { message: '你好', conversationId: 'conv_1' } as never
const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`

/** 收集响应体的一帧一帧（解析 `data:` 行） */
const makeResponse = () => {
  const chunks: string[] = []
  let headed = false
  const response: StreamResponseLike & { chunks: string[]; headed: () => boolean } = {
    chunks,
    headed: () => headed,
    writeHead: () => {
      headed = true
      return response
    },
    flushHeaders: () => undefined,
    write: (chunk: string) => {
      chunks.push(chunk)
      return true
    },
    end: () => undefined,
    on: () => undefined,
  }
  return response
}

const eventsOf = (chunks: string[]): string[] =>
  chunks
    .filter((chunk) => chunk.startsWith('data:'))
    .map((chunk) => String((JSON.parse(chunk.slice(5)) as { type?: unknown }).type))

const makeChat = () =>
  ({
    chatStream: vi.fn(
      async (
        _userId: string,
        _input: unknown,
        sink: StreamResponseLike,
        _isAdmin: boolean,
        _clientId: string | undefined,
        onRunCreated?: (run: { id: string; conversationId: string; taskId: string | null }) => void,
      ) => {
        onRunCreated?.({ id: 'run_1', conversationId: 'conv_1', taskId: null })
        sink.writeHead(200, {})
        sink.write(frame({ type: 'RUN_STARTED', threadId: 'conv_1', runId: 'run_1' }))
        sink.write(frame({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '你好' }))
        sink.write(frame({ type: 'RUN_FINISHED', threadId: 'conv_1', runId: 'run_1' }))
        sink.end()
      },
    ),
  }) as never

const makeRuns = () =>
  ({
    findEntity: vi.fn(
      async () =>
        ({
          id: 'run_1',
          conversationId: 'conv_1',
          status: 'succeeded',
          usage: null,
          errorCode: null,
          errorMessage: null,
        }) as unknown as RunEntity,
    ),
  }) as never

describe('RunExecutor v2 的 SSE 泵（wire format 不变）', () => {
  it('v2 下事件按 AG-UI 帧写回响应，收尾自动 end', async () => {
    const executor = new RunExecutor(makeChat(), makeRuns(), { engineV2: true } as never)
    const response = makeResponse()
    await executor.startStream(caller, { type: 'start', input }, response)

    expect(response.headed()).toBe(true)
    expect(eventsOf(response.chunks)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_CONTENT',
      'RUN_FINISHED',
    ])
  })

  it('建流前失败：错误抛回 HTTP，不写 200 响应头', async () => {
    const chat = {
      chatStream: vi.fn(async () => {
        throw new Error('会话不存在')
      }),
    } as never
    const executor = new RunExecutor(chat, makeRuns(), { engineV2: true } as never)
    const response = makeResponse()
    await expect(executor.startStream(caller, { type: 'start', input }, response)).rejects.toThrow(
      '会话不存在',
    )
    expect(response.headed()).toBe(false)
  })
})
