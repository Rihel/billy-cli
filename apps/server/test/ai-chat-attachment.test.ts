import { describe, expect, it, vi } from 'vitest'
import type { ChatAttachmentModel } from '@repo/shared'
import {
  ChatAttachmentService,
  looksLikeTextContent,
  withUserContent,
} from '../src/modules/ai/runtime/chat-attachment.service.js'
import type { ObjectStorage } from '@repo/kits'
import { AttachmentKeyPolicy } from '../src/modules/ai/runtime/attachment-key.js'
import { requestContext } from '../src/common/request-context/request-context.js'
import type { ModelMessage } from 'ai'

/**
 * 对话附件：把"存储 key"变成"模型能消费的内容"。
 *
 * 钉住四件事（每一条都对应一种会伤到用户的行为）：
 * 1. 图片走 image part 且内容是 **data URL**（不依赖供应商能不能访问我们的对象存储）；
 * 2. 文本类附件**内联成文字**（模型真读得到），超长截断且**明示截了多少**；
 * 3. 其它二进制走 file part（交给模型 / 供应商解析）；
 * 4. 读不回来的附件**抛错终止这一轮**，绝不静默丢掉用户发的东西。
 */

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 造一个假的对象存储：按 key 返回给定字节 */
const storageOf = (objects: Record<string, Buffer>): ObjectStorage =>
  ({
    getObject: async ({ key }: { key: string }) => {
      const body = objects[key]
      if (!body) throw new Error('NoSuchKey')
      return { key, body }
    },
  }) as unknown as ObjectStorage

const logger = { log: () => undefined, warn: () => undefined, error: vi.fn() } as never

/**
 * 归属校验策略。
 *
 * 真实判据读的是请求上下文（ALS）里的登录身份 —— 单测里不套 `requestContext.run` 时
 * 两个身份都是 `undefined`，策略按"鉴权关闭"放行（与 `StorageController` 同一姿态）。
 * 归属校验本身用 `requestContext.run` 包住的专门用例钉（见文件末尾）。
 */
const keyPolicyOf = (): AttachmentKeyPolicy => new AttachmentKeyPolicy()

const serviceOf = (objects: Record<string, Buffer>): ChatAttachmentService =>
  new ChatAttachmentService(storageOf(objects), keyPolicyOf(), logger)

const attachment = (partial: Partial<ChatAttachmentModel> = {}): ChatAttachmentModel => ({
  key: 'k1',
  filename: 'a.png',
  mediaType: 'image/png',
  bytes: 8,
  ...partial,
})

describe('ChatAttachmentService.buildUserContent', () => {
  it('没有附件时返回 null（调用方继续走纯文本快路）', async () => {
    const service = serviceOf({})
    await expect(service.buildUserContent('你好', undefined)).resolves.toBeNull()
    await expect(service.buildUserContent('你好', [])).resolves.toBeNull()
  })

  it('图片转成 image part，内容是 data URL', async () => {
    const service = serviceOf({ k1: pngBytes })
    const content = await service.buildUserContent('看看这张', [attachment()])

    expect(content).toEqual([
      { type: 'text', text: '看看这张' },
      {
        type: 'image',
        image: `data:image/png;base64,${pngBytes.toString('base64')}`,
        mediaType: 'image/png',
      },
    ])
  })

  it('媒体类型给不准时按后缀猜（浏览器常把 .md 报成 octet-stream）', async () => {
    const service = serviceOf({ k1: Buffer.from('# 标题') })
    const content = await service.buildUserContent('', [
      attachment({ filename: 'note.md', mediaType: 'application/octet-stream', bytes: 6 }),
    ])

    expect(content).toHaveLength(1)
    expect(content?.[0]).toMatchObject({ type: 'text' })
  })

  it('文本类附件内联成文字，并标注文件名', async () => {
    const service = serviceOf({ k1: Buffer.from('第一行\n第二行') })
    const content = await service.buildUserContent('看下这个', [
      attachment({ filename: 'a.csv', mediaType: 'text/csv', bytes: 13 }),
    ])

    const last = content?.at(-1) as { type: string; text: string }
    expect(last.type).toBe('text')
    expect(last.text).toContain('a.csv')
    expect(last.text).toContain('第一行\n第二行')
  })

  it('文本超长时截断，并把"截了多少"写进内容（不悄悄丢）', async () => {
    const long = 'x'.repeat(25_000)
    const service = serviceOf({ k1: Buffer.from(long) })
    const content = await service.buildUserContent('', [
      attachment({ filename: 'big.txt', mediaType: 'text/plain', bytes: long.length }),
    ])

    const last = content?.at(-1) as { text: string }
    expect(last.text).toContain('只截取了前 20000 个字符')
    expect(last.text.length).toBeLessThan(long.length)
  })

  it('未知二进制走 file part', async () => {
    const service = serviceOf({ k1: Buffer.from('%PDF-1.4') })
    const content = await service.buildUserContent('', [
      attachment({ filename: 'a.pdf', mediaType: 'application/pdf', bytes: 8 }),
    ])

    expect(content?.[0]).toMatchObject({
      type: 'file',
      filename: 'a.pdf',
      mediaType: 'application/pdf',
    })
  })

  it('只发附件不打字时，内容里只有附件 part', async () => {
    const service = serviceOf({ k1: pngBytes })
    const content = await service.buildUserContent('', [attachment()])
    expect(content).toHaveLength(1)
    expect(content?.[0]).toMatchObject({ type: 'image' })
  })

  it('取不回对象 → 抛业务错误（不静默丢掉用户发的东西）', async () => {
    const service = serviceOf({})
    await expect(service.buildUserContent('x', [attachment({ key: 'missing' })])).rejects.toThrow(
      /附件读取失败/,
    )
  })
})

describe('withUserContent', () => {
  it('替换最后一条用户消息的内容，历史部分原样保留', () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: '系统' },
      { role: 'user', content: '早前的问题' },
      { role: 'assistant', content: '早前的回答' },
      { role: 'user', content: '这一轮' },
    ]
    const next = withUserContent(messages, [
      { type: 'text', text: '这一轮' },
      { type: 'image', image: 'data:image/png;base64,AAAA', mediaType: 'image/png' },
    ])

    expect(next).toHaveLength(4)
    expect(next[0]).toEqual({ role: 'system', content: '系统' })
    expect(next[3].role).toBe('user')
    expect(Array.isArray(next[3].content)).toBe(true)
  })

  it('末条不是用户消息 → 抛错（而不是把附件悄悄丢掉）', () => {
    const messages: ModelMessage[] = [{ role: 'assistant', content: '只有助手' }]
    expect(() => withUserContent(messages, 'x')).toThrow()
    expect(() => withUserContent([], 'x')).toThrow()
  })
})

/** 支持图片 + 文件 */
const VISION_AND_FILE = ['text', 'image', 'file']
/** 明确只声明了文本（图片 / 文件都要被拦下） */
const TEXT_ONLY = ['text']

describe('模型模态校验（明确声明收不了就当场拒绝，不留给上游静默忽略）', () => {
  it('明确只收文本 + 图片附件 → 抛错并说清是哪个文件', async () => {
    const service = serviceOf({ k1: pngBytes })
    await expect(
      service.buildUserContent('看看', [attachment()], TEXT_ONLY),
    ).rejects.toThrow(/不支持图片输入/)
  })

  it('明确只收文本 + PDF → 抛错', async () => {
    const service = serviceOf({ k1: Buffer.from('%PDF-1.4') })
    await expect(
      service.buildUserContent('看看', [
        attachment({ filename: 'a.pdf', mediaType: 'application/pdf' }),
      ], TEXT_ONLY),
    ).rejects.toThrow(/不支持文件输入/)
  })

  it('文本类附件**任何模型都放行**（我们自己读出来，不依赖模型能力）', async () => {
    const service = serviceOf({ k1: Buffer.from('一行文字') })
    const content = await service.buildUserContent('看看', [
      attachment({ filename: 'note.md', mediaType: 'text/markdown' }),
    ], TEXT_ONLY)
    expect(content?.[0]).toMatchObject({ type: 'text' })
  })

  it('**未声明（null）不拦**：国内厂商普遍不给模态，硬拦会误伤真正的视觉模型', async () => {
    const service = serviceOf({ k1: pngBytes })
    await expect(service.buildUserContent('看看', [attachment()], null)).resolves.toBeTruthy()
  })

  it('没给模态（清单还没到手）时也不拦，交给上游判', async () => {
    const service = serviceOf({ k1: pngBytes })
    await expect(service.buildUserContent('看看', [attachment()], undefined)).resolves.toBeTruthy()
  })

  it('认不出类型的二进制：**先当文本试**，读得出来就内联（任何模型都能用）', async () => {
    const service = serviceOf({ k1: Buffer.from('2026-10-07 11:00 INFO 服务已启动') })
    const content = await service.buildUserContent('看看日志', [
      attachment({ filename: 'app.log', mediaType: 'application/octet-stream' }),
    ], TEXT_ONLY)
    expect(content?.[0]).toMatchObject({ type: 'text' })
  })

  it('二进制且读不出文本、模型也收不了文件 → 明确拒绝（而不是塞幻觉进去）', async () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0xfe])
    const service = serviceOf({ k1: binary })
    await expect(
      service.buildUserContent('看看', [
        attachment({ filename: 'blob.bin', mediaType: 'application/octet-stream' }),
      ], VISION_AND_FILE),
    ).rejects.toThrow()
  })
})

describe('looksLikeTextContent', () => {
  it('正常文本 / 代码 / 日志都算文本', () => {
    expect(looksLikeTextContent(Buffer.from('hello'))).toBe(true)
    expect(looksLikeTextContent(Buffer.from('第一行\n第二行'))).toBe(true)
  })

  it('含 NUL 字节的按二进制处理（PNG / PDF 头带 NUL）', () => {
    expect(looksLikeTextContent(pngBytes)).toBe(false)
    expect(looksLikeTextContent(Buffer.from([0x00, 0x41]))).toBe(false)
  })

  it('空内容不算文本（没什么可读的）', () => {
    expect(looksLikeTextContent(Buffer.alloc(0))).toBe(false)
  })
})

describe('附件 key 归属校验（**读对象之前**，防越权）', () => {
  /** 以指定身份跑一段逻辑（策略读的是请求上下文里的登录身份） */
  const asUser = <T,>(userId: string, run: () => T): T =>
    requestContext.run({ requestId: 't', userId, adminId: null }, run)
  const asAdmin = <T,>(run: () => T): T =>
    requestContext.run({ requestId: 't', userId: null, adminId: 'admin_1' }, run)
  const anonymous = <T,>(run: () => T): T =>
    requestContext.run({ requestId: 't', userId: null, adminId: null }, run)

  it('前台用户读**别人**的文件 → 拒绝', () => {
    const policy = keyPolicyOf()
    expect(() => asUser('u1', () => policy.assertOwned(['user/u2/secret.png']))).toThrow(
      /无权访问/,
    )
  })

  it('前台用户读自己的文件 → 通过', () => {
    const policy = keyPolicyOf()
    expect(() => asUser('u1', () => policy.assertOwned(['user/u1/mine.png']))).not.toThrow()
  })

  it('前台用户伪造"自己前缀 + 别人文件名"没用（前缀必须是自己的）', () => {
    const policy = keyPolicyOf()
    expect(() => asUser('u1', () => policy.assertOwned(['user/u1/u2/secret.png']))).not.toThrow()
    // 但指向别人前缀的一律拒绝
    expect(() => asUser('u1', () => policy.assertOwned(['/user/u2/secret.png']))).toThrow()
  })

  it('空 key → 拒绝（不静默跳过）', () => {
    const policy = keyPolicyOf()
    expect(() => asUser('u1', () => policy.assertOwned(['   ']))).toThrow()
  })

  it('管理员与鉴权关闭按现状放行（管理员后台上传不加前缀）', () => {
    const policy = keyPolicyOf()
    expect(() => asAdmin(() => policy.assertOwned(['plain-object.png']))).not.toThrow()
    expect(() => anonymous(() => policy.assertOwned(['user/anyone/x.png']))).not.toThrow()
  })

  it('**越权在取对象之前就被拦下**（不会先把别人的文件读进内存）', async () => {
    const getObject = vi.fn(async () => ({ key: 'x', body: pngBytes }))
    const storage = { getObject } as unknown as ObjectStorage
    const service = new ChatAttachmentService(storage, keyPolicyOf(), logger)

    await expect(
      asUser('u1', () => service.buildUserContent('看看', [
        attachment({ key: 'user/u2/secret.png' }),
      ])),
    ).rejects.toThrow(/无权访问/)

    expect(getObject).not.toHaveBeenCalled()
  })
})
