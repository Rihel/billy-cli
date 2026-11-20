import { describe, expect, it } from 'vitest'
import { credentialVersionOf } from '../src/credential'

/**
 * 主体级凭据版本（§6.4.6 的 `credentialVersion`）。
 *
 * 口径：**活跃条数 + 最大 version**。`version` 只在凭据真正变化时 +1，
 * `last_used_at` 的触碰不参与 —— 否则每次解析都会把版本顶高，工作区永远"落后"。
 */
describe('credentialVersionOf', () => {
  it('条数 + 最大 version', () => {
    expect(credentialVersionOf([])).toBe('0-0')
    expect(credentialVersionOf([{ version: 1 }])).toBe('1-1')
    expect(credentialVersionOf([{ version: 1 }, { version: 3 }])).toBe('2-3')
  })

  it('缺 version 的老数据按 0 处理（不炸、不会算出 NaN）', () => {
    expect(credentialVersionOf([{}, { version: null }])).toBe('2-0')
  })

  it('吊销后条数减少 → 版本必变（不会停在旧值）', () => {
    expect(credentialVersionOf([{ version: 3 }])).not.toBe(
      credentialVersionOf([{ version: 3 }, { version: 1 }]),
    )
  })
})
