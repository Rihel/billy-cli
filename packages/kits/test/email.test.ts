import { afterEach, describe, expect, it, vi } from 'vitest'
import nodemailer from 'nodemailer'
import { EmailClient } from '../src/notification/email/email.client.js'
import type { NotifyConfig } from '../src/notification/notify.config.js'
import { testLogger } from './helpers/logger.js'

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: vi.fn(async () => ({ messageId: 'mock-id' })),
    })),
  },
}))

const createTransportMock = vi.mocked(nodemailer.createTransport)

const createClient = (config: NotifyConfig): EmailClient => new EmailClient(config, testLogger())

describe('EmailClient（nodemailer SMTP）', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('未配置 email 段：configured=false，send 返回通道未配置', async () => {
    const client = createClient({})
    expect(client.configured).toBe(false)
    expect(await client.send({ to: 'a@b.com', subject: 's', text: 't' })).toEqual({
      ok: false,
      error: '通道未配置：email',
    })
  })

  it('配置 email 段：创建 transport（含 auth），sendMail 携带 from/to/subject/text', async () => {
    const client = createClient({
      email: {
        host: 'smtp.corp.com',
        port: 465,
        secure: true,
        user: 'u',
        pass: 'p',
        from: 'noreply@corp.com',
      },
    })
    expect(client.configured).toBe(true)

    const result = await client.send({
      to: 'ops@corp.com',
      subject: '告警：服务异常',
      text: '请求失败率超阈值',
    })

    expect(result).toEqual({ ok: true })
    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.corp.com',
        port: 465,
        secure: true,
        auth: { user: 'u', pass: 'p' },
      }),
    )
    const sendMail = createTransportMock.mock.results[0].value.sendMail as ReturnType<typeof vi.fn>
    expect(sendMail).toHaveBeenCalledWith({
      from: 'noreply@corp.com',
      to: 'ops@corp.com',
      subject: '告警：服务异常',
      text: '请求失败率超阈值',
    })
  })

  it('无认证信息时不传 auth', () => {
    createClient({ email: { host: 'smtp.corp.com', port: 25, secure: false, from: 'a@b.com' } })
    expect(createTransportMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ auth: expect.anything() }),
    )
  })

  it('sendMail 失败：捕获返回 { ok:false } 不抛错', async () => {
    const sendMail = vi.fn(async () => {
      throw new Error('SMTP 530 auth failed')
    })
    createTransportMock.mockReturnValueOnce({ sendMail } as never)
    const client = createClient({
      email: { host: 'smtp.corp.com', port: 465, secure: true, from: 'a@b.com' },
    })

    const result = await client.send({ to: 'b@c.com', subject: 's', text: 't' })
    expect(result).toEqual({ ok: false, error: 'SMTP 530 auth failed' })
  })

  it('payload 非邮件形状（content）：返回不支持', async () => {
    const client = createClient({
      email: { host: 'smtp.corp.com', port: 465, secure: true, from: 'a@b.com' },
    })
    const result = await client.send({ content: 'hi' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('仅支持 to / subject / text')
  })
})
