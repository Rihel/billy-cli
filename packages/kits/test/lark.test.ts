import { describe, expect, it } from 'vitest'
import { LarkClient } from '../src/lark/lark.client.js'
import type { LarkConfig } from '../src/lark/lark.config.js'

describe('LarkClient（飞书官方 SDK 封装 bean）', () => {
  it('按配置创建官方 Client（raw 暴露完整能力）', () => {
    const client = new LarkClient({
      appId: 'cli_test',
      appSecret: 'sec_test',
    } as LarkConfig)

    expect(client.raw).toBeDefined()
    // 官方 SDK 能力可用（im 消息等）
    expect(typeof client.raw.im.message.create).toBe('function')
  })
})
