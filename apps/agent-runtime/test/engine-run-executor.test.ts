import { describe, expect, it, vi } from 'vitest'
import { RunExecutor } from '../src/modules/ai/engine/run-executor.js'
import { createTaskId } from '../src/modules/ai/engine/task-id.js'

const caller = { id: 'user_1', isAdmin: false }
const response = {} as never
const input = { message: '你好' } as never

const makeChat = () =>
  ({
    chat: vi.fn(async () => ({ runId: 'run_1', content: 'ok' })),
    chatStream: vi.fn(async () => undefined),
    resumeChat: vi.fn(async () => undefined),
    stopRun: vi.fn(async () => ({ stopped: true })),
    snapshotRun: vi.fn(async () => null),
    snapshotCurrentRun: vi.fn(async () => null),
    resumeCurrentRun: vi.fn(async () => true),
    resumeRun: vi.fn(async () => true),
  }) as never

describe('RunExecutor', () => {
  it('非流式：把命令里的输入与调用方身份透传给执行服务', async () => {
    const chat = makeChat()
    const executor = new RunExecutor(chat)
    await executor.startOnce(caller, { type: 'start', input })
    expect((chat as never as { chat: ReturnType<typeof vi.fn> }).chat).toHaveBeenCalledWith(
      'user_1',
      input,
      false,
    )
  })

  it('流式：透传 clientId', async () => {
    const chat = makeChat()
    const executor = new RunExecutor(chat)
    await executor.startStream(caller, { type: 'start', input, clientId: 'client_1' }, response)
    expect(
      (chat as never as { chatStream: ReturnType<typeof vi.fn> }).chatStream,
    ).toHaveBeenCalledWith('user_1', input, response, false, 'client_1')
  })

  it('续跑、停止、快照、重连都走同一条命令入口', async () => {
    const chat = makeChat()
    const executor = new RunExecutor(chat)
    const resume = { runId: 'run_1' } as never
    await executor.resumeStream(
      caller,
      { type: 'resume', input: resume, clientId: 'client_1' },
      response,
    )
    await executor.stop(caller, { type: 'stop', input: { runId: 'run_1' } as never })
    await executor.snapshot(caller, { type: 'snapshot', runId: 'run_1' })
    await executor.snapshot(caller, { type: 'snapshot', conversationId: 'conv_1' })
    await executor.attach(caller, { type: 'attach', runId: 'run_1', sinceRev: 3 }, response)
    await executor.attach(
      caller,
      { type: 'attach', conversationId: 'conv_1', sinceRev: 4, clientId: 'client_1' },
      response,
    )
    expect(
      (chat as never as { resumeChat: ReturnType<typeof vi.fn> }).resumeChat,
    ).toHaveBeenCalledWith('user_1', resume, response, false, 'client_1')
    expect((chat as never as { stopRun: ReturnType<typeof vi.fn> }).stopRun).toHaveBeenCalledWith(
      'user_1',
      { runId: 'run_1' },
    )
    expect(
      (chat as never as { snapshotRun: ReturnType<typeof vi.fn> }).snapshotRun,
    ).toHaveBeenCalledWith('user_1', 'run_1')
    expect(
      (chat as never as { snapshotCurrentRun: ReturnType<typeof vi.fn> }).snapshotCurrentRun,
    ).toHaveBeenCalledWith('user_1', 'conv_1')
    expect(
      (chat as never as { resumeRun: ReturnType<typeof vi.fn> }).resumeRun,
    ).toHaveBeenCalledWith('user_1', 'run_1', 3, response, undefined)
    expect(
      (chat as never as { resumeCurrentRun: ReturnType<typeof vi.fn> }).resumeCurrentRun,
    ).toHaveBeenCalledWith('user_1', 4, response, 'conv_1', 'client_1')
  })
})

describe('createTaskId', () => {
  it('生成 task_ 前缀、长度稳定、互不重复', () => {
    const a = createTaskId()
    const b = createTaskId()
    expect(a).toMatch(/^task_[A-Za-z0-9_-]{16}$/)
    expect(a).toHaveLength(21)
    expect(a).not.toBe(b)
  })
})
