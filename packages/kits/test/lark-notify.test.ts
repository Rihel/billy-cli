import { afterEach, describe, expect, it, vi } from 'vitest'
import { LarkNotifyClient } from '../src/infrastructure/lark-notify/lark-notify.client.js'
import { LarkClient } from '../src/infrastructure/lark/lark.client.js'
import type { NotifyConfig } from '../src/foundation/config/notify-config.js'

const createClient = (config: NotifyConfig): LarkNotifyClient => {
  const mockLark = {
    raw: {
      im: {
        message: {
          create: vi.fn(async () => ({ code: 0 })),
        },
      },
    },
  } as unknown as LarkClient
  return { client: new LarkNotifyClient(mockLark, config), mockCreate: mockLark.raw.im.message.create }
}

type Returned = ReturnType<typeof createClient>

describe('LarkNotifyClient（基于 LarkClient 的通知 bean）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('未配置 notify.lark：configured=false，send 返回通道未配置', async () => {
    const { client } = createClient({})
    expect(client.configured).toBe(false)
    expect(await client.send({ content: 'hi' })).toEqual({
      ok: false,
      error: '通道未配置：lark',
    })
  })

  it('发送成功：经 LarkClient 调 im.message.create，payload 为 text 消息', async () => {
    const { client, mockCreate } = createClient({
      lark: { receiveId: 'ou_123', receiveIdType: 'open_id' },
    })
    expect(client.configured).toBe(true)

    const result = await client.send({ content: '订单支付失败：xxx' })

    expect(result).toEqual({ ok: true })
    expect(mockCreate).toHaveBeenCalledWith({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: 'ou_123',
        msg_type: 'text',
        content: JSON.stringify({ text: '订单支付失败：xxx' }),
      },
    })
  })

  it('receiveIdType 默认 open_id，可配置为 chat_id（群通知）', async () => {
    const { client, mockCreate } = createClient({
      lark: { receiveId: 'oc_456', receiveIdType: 'chat_id' },
    })
    await client.send({ content: '群通知' })
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { receive_id_type: 'chat_id' } }),
    )
  })

  it('API 异常：捕获返回 { ok:false } 不抛错', async () => {
    const { client, mockCreate } = createClient({ lark: { receiveId: 'ou_1' } })
    mockCreate.mockRejectedValueOnce(new Error('tenant_access_token invalid'))
    const result = await client.send({ content: 'hi' })
    expect(result).toEqual({ ok: false, error: 'tenant_access_token invalid' })
  })

  it('payload 非文本（email 形状）：返回不支持', async () => {
    const { client } = createClient({ lark: { receiveId: 'ou_1' } })
    const result = await client.send({ to: 'a@b.com', subject: 's', text: 't' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('仅支持文本消息')
  })
})
