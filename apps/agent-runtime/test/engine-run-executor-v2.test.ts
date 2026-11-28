import { describe, expect, it, vi } from 'vitest'
import type { RunEntity } from '@repo/db'
import { RunExecutor } from '../src/modules/ai/engine/run-executor.js'
import { ConversationNotFoundError } from '../src/modules/ai/foundation/errors.js'
import { AppErrorCodes } from '@repo/shared'
import type { EngineStreamEvent } from '../src/modules/ai/engine/run-execution.js'
import type { StreamResponseLike } from '../src/modules/ai/runtime/stream/stream-response.js'

const caller = { id: 'user_1', isAdmin: false }
const input = { message: '你好', conversationId: 'conv_1' } as never

const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`

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
        onRunCreated?.({ id: 'run_1', conversationId: 'conv_1', taskId: 'task_1' })
        sink.writeHead(200, {})
        sink.write(frame({ type: 'RUN_STARTED', threadId: 'conv_1', runId: 'run_1' }))
        sink.write(frame({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '你好' }))
        sink.write(frame({ type: 'RUN_FINISHED', threadId: 'conv_1', runId: 'run_1' }))
        sink.end()
      },
    ),
    resumeChat: vi.fn(async () => undefined),
    stopRun: vi.fn(async () => ({ stopped: true })),
  }) as never

const makeRuns = (status: string) =>
  ({
    findEntity: vi.fn(
      async () =>
        ({
          id: 'run_1',
          conversationId: 'conv_1',
          status,
          usage: { totalTokens: 3 },
          errorCode: null,
          errorMessage: null,
        }) as unknown as RunEntity,
    ),
  }) as never

const collect = async (events: AsyncIterable<EngineStreamEvent>): Promise<EngineStreamEvent[]> => {
  const list: EngineStreamEvent[] = []
  for await (const event of events) list.push(event)
  return list
}

describe('RunExecutor v2（RunExecution 事件流）', () => {
  it('start 返回执行句柄：事件可迭代、结果是 run 终态', async () => {
    const executor = new RunExecutor(makeChat(), makeRuns('succeeded'), { engineV2: true } as never)
    const execution = await executor.start(caller, { type: 'start', input })

    expect(execution.runId).toBe('run_1')
    expect(execution.conversationId).toBe('conv_1')
    expect(execution.taskId).toBe('task_1')

    const events = await collect(execution.events)
    expect(events.map((event) => event.type)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_CONTENT',
      'RUN_FINISHED',
    ])

    const outcome = await execution.result
    expect(outcome).toMatchObject({
      runId: 'run_1',
      conversationId: 'conv_1',
      status: 'succeeded',
      stopReason: 'done',
    })
  })

  it('取消 / 挂起 / 中断都映射成对应状态与停止原因', async () => {
    const cases: Array<[string, string, string]> = [
      ['canceled', 'canceled', 'canceled'],
      ['suspended', 'suspended', 'suspended'],
      ['interrupted', 'failed', 'interrupted'],
    ]
    for (const [status, expected, stopReason] of cases) {
      const executor = new RunExecutor(makeChat(), makeRuns(status), {
        engineV2: true,
      } as never)
      const execution = await executor.start(caller, { type: 'start', input })
      await collect(execution.events)
      const outcome = await execution.result
      expect(outcome.status).toBe(expected)
      expect(outcome.stopReason).toBe(stopReason)
    }
  })

  it('建 run 失败时 start 直接抛出原始业务错误（错误码是 wire format 的一部分）', async () => {
    const chat = {
      chatStream: vi.fn(async () => {
        throw new ConversationNotFoundError('conv_1')
      }),
    } as never
    const executor = new RunExecutor(chat, makeRuns('failed'), { engineV2: true } as never)
    await expect(executor.start(caller, { type: 'start', input })).rejects.toMatchObject({
      code: AppErrorCodes.ConversationNotFound,
    })
  })

  it('engineV2=false 时退回直写路径（行为与旧入口一致）', async () => {
    const chat = { chatStream: vi.fn(async () => undefined) } as never
    const executor = new RunExecutor(chat, makeRuns('succeeded'), { engineV2: false } as never)
    const response = {} as never
    await executor.startStream(caller, { type: 'start', input }, response)
    expect(
      (chat as never as { chatStream: ReturnType<typeof vi.fn> }).chatStream,
    ).toHaveBeenCalledWith('user_1', input, response, false, undefined)
  })
})
