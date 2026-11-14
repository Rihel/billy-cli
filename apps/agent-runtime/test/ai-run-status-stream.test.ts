import { describe, expect, it, vi } from 'vitest'
import { STREAM_AI_OWNER_CHANNEL_PREFIX, STREAM_CONVERSATION_RUN_CHANGED_EVENT } from '@repo/shared'
import { RunStatusStream } from '../src/modules/ai/runtime/run-status.stream.js'
import { silentLogger } from './helpers/ai-tool-stack.js'

/**
 * 会话运行态推流：侧栏呼吸灯从"条件轮询"改成"事件驱动"后的发布端。
 *
 * 这里钉三件事：
 * 1. 频道与事件名符合协议（客户端据此订阅、分发）；
 * 2. `running` 取自**库里的真相**（`isRunning`），不是从状态机猜的；
 * 3. 旁路失败（推流抛错）不能影响运行主流程。
 */
function build(ownerId: string | null, running: boolean) {
  const publish = vi.fn()
  const conversations = {
    findOwnerId: vi.fn(async () => ownerId),
    isRunning: vi.fn(async () => running),
  }
  const logger = { ...silentLogger, warn: vi.fn() }
  const stream = new RunStatusStream({ publish } as never, conversations as never, logger as never)
  return { stream, publish, conversations, logger }
}

describe('会话运行态推流（ai:owner 频道）', () => {
  it('发到归属者的派生频道，负载是「会话 id + 库里现算的 running」', async () => {
    const { stream, publish, conversations } = build('admin_1', true)

    await stream.changed('conv_1')

    expect(conversations.isRunning).toHaveBeenCalledWith('conv_1')
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith(`${STREAM_AI_OWNER_CHANNEL_PREFIX}admin_1`, {
      event: STREAM_CONVERSATION_RUN_CHANGED_EVENT,
      data: { conversationId: 'conv_1', running: true },
    })
  })

  it('会话不存在（归属者查不到）时静默跳过，不推空频道', async () => {
    const { stream, publish } = build(null, false)

    await stream.changed('conv_missing')

    expect(publish).not.toHaveBeenCalled()
  })

  it('推流失败只记 warn，不把异常抛回运行主流程', async () => {
    const logger = { ...silentLogger, warn: vi.fn() }
    const broken = new RunStatusStream(
      {
        publish: () => {
          throw new Error('redis down')
        },
      } as never,
      { findOwnerId: async () => 'admin_1', isRunning: async () => false } as never,
      logger as never,
    )

    await expect(broken.changed('conv_1')).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      'ai.run_status.stream_failed',
      expect.objectContaining({ conversationId: 'conv_1' }),
    )
  })
})
