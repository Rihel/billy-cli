import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FileClient } from '../src/infrastructure/file/file.client.js'
import type { NotifyConfig } from '../src/foundation/config/notify-config.js'

const createClient = (config: NotifyConfig): FileClient =>
  new FileClient(config)

describe('FileClient（文件输出，默认兜底通道）', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'billy-file-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('零配置始终可用（configured 恒 true）', () => {
    const client = createClient({})
    expect(client.configured).toBe(true)
  })

  it('发送成功：内容追加写入文件（默认 logs/alerts.log 相对路径）', async () => {
    const client = createClient({})
    const result = await client.send({ content: '【告警】错误码 1000\n邮箱不存在' })
    expect(result).toEqual({ ok: true })
  })

  it('自定义路径：写入指定文件', async () => {
    const filePath = path.join(tempDir, 'nested', 'alerts.log')
    const client = createClient({ file: { path: filePath } })

    await client.send({ content: '【告警】测试' })
    const content = await readFile(filePath, 'utf8')
    expect(content).toContain('【告警】测试')
    expect(content).toContain(new Date().toISOString().slice(0, 10))
  })

  it('追加写入：多次发送内容累积', async () => {
    const filePath = path.join(tempDir, 'alerts.log')
    const client = createClient({ file: { path: filePath } })

    await client.send({ content: '第一条' })
    await client.send({ content: '第二条' })
    const content = await readFile(filePath, 'utf8')
    expect(content).toContain('第一条')
    expect(content).toContain('第二条')
  })

  it('payload 非文本：返回不支持', async () => {
    const client = createClient({})
    const result = await client.send({ to: 'a@b.com', subject: 's', text: 't' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('仅支持文本消息')
  })
})
