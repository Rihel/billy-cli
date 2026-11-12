import { describe, expect, it } from 'vitest'
import { createAppClients } from '@repo/sdk'

/**
 * AI 流的四个地址（SDK 约定，纯字符串，node 环境）。
 *
 * 为什么值得单测：这四条地址的**方法**必须不同，且重连必须是**能被 GET 的**地址。
 * 曾经踩过的坑：`useChat({ resume: true })` 挂载时一定会发 **GET**，而建流端点是 POST-only ——
 * 把重连指到建流地址，浏览器就会对 `POST /agent/chat/stream` 发 GET，**接口直接 404**。
 * 这条用例把"哪个地址用来干什么"钉死，改坏了当场红。
 */
const { createServerClient } = createAppClients({
  tokenKey: 'test-access-token',
  publicBaseUrl: 'http://public.test',
  serverBaseUrl: 'http://server.test',
})

const client = createServerClient('test-token')

describe('AI 流地址', () => {
  it('建流是 POST 地址（/agent/chat/stream）', () => {
    expect(client.agent.chatStreamUrl()).toBe('http://server.test/agent/chat/stream')
  })

  it('回答挂起走 POST /agent/chat/resume', () => {
    expect(client.agent.chatResumeUrl()).toBe('http://server.test/agent/chat/resume')
  })

  it('重连（不知道 runId）走 GET /agent/run/stream —— **绝不能是建流地址**', () => {
    const url = client.agent.currentRunStreamUrl()
    expect(url).toBe('http://server.test/agent/run/stream?offset=0')
    expect(url).not.toContain('/agent/chat/stream')
    expect(client.agent.currentRunStreamUrl(12)).toBe(
      'http://server.test/agent/run/stream?offset=12',
    )
  })

  it('重连带 conversationId：只在当前会话内找活动 run（防串流）', () => {
    expect(client.agent.currentRunStreamUrl(0, 'conv_1')).toBe(
      'http://server.test/agent/run/stream?offset=0&conversationId=conv_1',
    )
    // 特殊字符要转义，避免拼出坏参数
    expect(client.agent.currentRunStreamUrl(3, 'a b&c')).toBe(
      'http://server.test/agent/run/stream?offset=3&conversationId=a%20b%26c',
    )
    // 不传时保持旧口径（兼容没有会话上下文的调用）
    expect(client.agent.currentRunStreamUrl(0)).toBe('http://server.test/agent/run/stream?offset=0')
  })

  it('重连（知道 runId）走 GET /agent/run/:runId/stream，offset 透传', () => {
    expect(client.agent.resumeStreamUrl('run_1', 7)).toBe(
      'http://server.test/agent/run/run_1/stream?offset=7',
    )
    // runId 需要转义，避免拼出奇怪路径
    expect(client.agent.resumeStreamUrl('a/b')).toContain('a%2Fb')
  })

  it('鉴权头与普通请求同一套（未登录时不带 Authorization）', async () => {
    await expect(client.agent.authHeaders()).resolves.toEqual({
      Authorization: 'Bearer test-token',
    })
    const anonymous = createServerClient()
    await expect(anonymous.agent.authHeaders()).resolves.toEqual({})
  })
})
