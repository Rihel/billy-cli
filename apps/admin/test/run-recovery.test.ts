import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import {
  canStartRecovery,
  mergeAssistantMessage,
  submitResumeRequest,
} from '../src/app/(app)/(standalone)/main/ai/chat/run-recovery'

/**
 * 恢复结束后的合并顺序（手册 §7.3）。
 *
 * 钉住的是用户可见的那条：同 id **原位替换**，不能"先删再追加到末尾" ——
 * 否则一轮结束后用户发下一条时会看到 `[user1, user2, AI]`。
 */

const message = (id: string, text: string): UIMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text }],
})

describe('mergeAssistantMessage', () => {
  it('同 id 原位替换，位置不变', () => {
    const messages = [message('u1', '问'), message('a1', '半截'), message('u2', '再问')]
    const merged = mergeAssistantMessage(messages, message('a1', '完整回答'))
    expect(merged.map((item) => item.id)).toEqual(['u1', 'a1', 'u2'])
    expect(merged[1]?.parts).toEqual([{ type: 'text', text: '完整回答' }])
    // 不改入参
    expect(messages[1]?.parts).toEqual([{ type: 'text', text: '半截' }])
  })

  it('没有同 id 才追加到末尾', () => {
    const merged = mergeAssistantMessage([message('u1', '问')], message('a1', '回答'))
    expect(merged.map((item) => item.id)).toEqual(['u1', 'a1'])
  })
})

/**
 * 续跑提交的同步闸门（issue 12）。
 *
 * 钉住两条用户可见的时序：
 * 1. `begin`（在途 ref + `resuming`）必须在 `fetch` **之前**生效 —— 只靠 state 会晚一帧，
 *    服务端收到 resume 就开跑，恢复流会抢走 Redis 单槽的 clientId；
 * 2. 提交失败要回落空闲并按需接回恢复（服务端可能其实已经收到答案并在跑），错误照常抛给卡片。
 */
describe('submitResumeRequest', () => {
  it('先占位、后发请求：send 执行时「本地在途」已为 true', async () => {
    const events: string[] = []
    let resuming = false
    const response = await submitResumeRequest(
      {
        begin: () => {
          events.push('begin')
          resuming = true
        },
        clear: () => {
          events.push('clear')
          resuming = false
        },
        recover: () => events.push('recover'),
      },
      async () => {
        events.push(`send:${resuming}`)
        return new Response(null, { status: 200 })
      },
    )

    expect(response.ok).toBe(true)
    expect(events).toEqual(['begin', 'send:true'])
  })

  it('发送失败：先回落空闲，再按需接回恢复，异常继续抛给卡片', async () => {
    const events: string[] = []
    let resuming = false
    await expect(
      submitResumeRequest(
        {
          begin: () => {
            resuming = true
            events.push(`begin:${resuming}`)
          },
          clear: () => {
            resuming = false
            events.push(`clear:${resuming}`)
          },
          recover: () => events.push(`recover:${resuming}`),
        },
        async () => {
          events.push(`send:${resuming}`)
          throw new Error('续跑失败（HTTP 504）')
        },
      ),
    ).rejects.toThrow('504')

    // 恢复入口看到的是"已回落空闲"，才允许接回
    expect(events).toEqual(['begin:true', 'send:true', 'clear:false', 'recover:false'])
  })
})

/**
 * 恢复链路的自动 / 手动入口共用这道判据：本地续跑在途时一条都不能开。
 */
describe('canStartRecovery', () => {
  it('本地续跑在途：自动与手动入口都不许再 startRecovery', () => {
    expect(canStartRecovery({ blocked: true, starting: false, hasController: false })).toBe(false)
    expect(canStartRecovery({ blocked: true, starting: true, hasController: false })).toBe(false)
  })

  it('只有解除在途后才允许启动；已有协程 / 流时不重复开', () => {
    expect(canStartRecovery({ blocked: false, starting: false, hasController: false })).toBe(true)
    expect(canStartRecovery({ blocked: false, starting: true, hasController: false })).toBe(false)
    expect(canStartRecovery({ blocked: false, starting: false, hasController: true })).toBe(false)
  })
})
