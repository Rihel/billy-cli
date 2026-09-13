import { describe, expect, it, vi } from 'vitest'
import { Notifier } from '../src/notification/notifier.js'
import type { NotifyClient, SendResult } from '../src/notification/notifier.js'

const mockClient = (channel: 'lark' | 'email'): NotifyClient => ({
  channel,
  configured: true,
  send: vi.fn(async () => ({ ok: true } satisfies SendResult)),
})

describe('Notifier（注入客户端编排路由）', () => {
  it('send 按 channel 路由到对应客户端', async () => {
    const lark = mockClient('lark')
    const email = mockClient('email')
    const notifier = new Notifier(undefined, lark as never, email as never)

    await notifier.send('lark', { content: '飞书消息' })
    await notifier.send('email', { to: 'a@b.com', subject: 's', text: 't' })

    expect(lark.send).toHaveBeenCalledWith({ content: '飞书消息' })
    expect(email.send).toHaveBeenCalledWith({ to: 'a@b.com', subject: 's', text: 't' })
    expect(lark.send).toHaveBeenCalledTimes(1)
    expect(email.send).toHaveBeenCalledTimes(1)
  })

  it('客户端失败结果原样透传', async () => {
    const lark: NotifyClient = {
      channel: 'lark',
      configured: true,
      send: vi.fn(async () => ({ ok: false, error: '通道未配置：lark' })),
    }
    const notifier = new Notifier(undefined, lark, mockClient('email') as never)

    const result = await notifier.send('lark', { content: 'x' })
    expect(result).toEqual({ ok: false, error: '通道未配置：lark' })
  })
})
