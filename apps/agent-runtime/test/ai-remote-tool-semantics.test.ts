import { describe, expect, it, vi } from 'vitest'
import { ToolCallMetaStore } from '../src/modules/ai/tools/engine/tool.meta.js'
import { ToolGateway } from '../src/modules/ai/tools/engine/tool.gateway.js'
import { toReason } from '../src/modules/ai/runtime/common/remote-tool.client.js'

/**
 * 目录能力的拒绝语义链（issue 11）。
 *
 * 三处必须一起成立，否则模型读到的是"unknown-tool / internal"这种不可纠正的结论：
 * ① 领域原因有映射；② 远程调用也写审计旁证（目录能力不经本进程插件链）；
 * ③ 旁证里的 reason 是映射后的领域原因。
 */

const envelope = {
  conversationId: 'c_1',
  parentRunId: 'r_1',
  triggeredBy: 'u_1',
  isAdmin: false,
  agentKey: 'main',
  rootAgentKey: 'main',
  depth: 0,
} as never

const makeGateway = (invoke: (input: unknown) => Promise<unknown>) => {
  const metas = new ToolCallMetaStore()
  const remote = { supports: () => true, invoke: vi.fn(invoke) }
  const gateway = new ToolGateway(
    { settings: vi.fn() } as never,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    [] as never,
    { now: () => 1_000 } as never,
    remote as never,
    null,
    metas,
  )
  return { gateway, metas, remote }
}

describe('网关原因 → 领域 reason', () => {
  it('缺凭据 / 没绑工作区 / 入库失败都是可纠正的前置条件，不是 internal', () => {
    expect(toReason('missing-credential')).toBe('precheck-failed')
    expect(toReason('no-workspace')).toBe('precheck-failed')
    expect(toReason('import-failed')).toBe('precheck-failed')
  })

  it('不支持的能力标 unknown-tool，而不是掉进 internal', () => {
    expect(toReason('unsupported-tool')).toBe('unknown-tool')
  })

  it('原有映射保持不变（超时 / 限流 / 上游）', () => {
    expect(toReason('timeout')).toBe('timeout')
    expect(toReason('rate-limited')).toBe('rate-limited')
    expect(toReason('mcp-tool-error')).toBe('upstream')
    expect(toReason('something-new')).toBe('internal')
  })
})

describe('远程调用的审计旁证', () => {
  const spec = { key: 'bash', exec: vi.fn() } as never

  it('失败也写旁证：reason 是领域原因，且带上模型写的调用理由', async () => {
    const { gateway, metas } = makeGateway(async () => ({
      ok: false,
      reason: 'precheck-failed',
      message: '缺少「飞书（Lark）」凭据',
      retryable: true,
    }))

    const outcome = await gateway.invoke(
      spec,
      { command: 'lark-cli im send', reason: '看群消息' },
      { callId: 'tc_1', envelope } as never,
    )

    expect(outcome).toMatchObject({ ok: false, reason: 'precheck-failed', retryable: true })
    expect(metas.take('r_1', 'tc_1')).toMatchObject({
      ok: false,
      reason: 'precheck-failed',
      callReason: '看群消息',
      configVersion: 'gateway',
    })
  })

  it('成功同样写旁证（耗时 / 出参字节数）', async () => {
    const { gateway, metas } = makeGateway(async () => ({ ok: true, data: { stdout: 'hi' } }))

    await gateway.invoke(spec, { command: 'echo hi' }, { callId: 'tc_2', envelope } as never)

    const meta = metas.take('r_1', 'tc_2')
    expect(meta).toMatchObject({ ok: true, configVersion: 'gateway' })
    expect(meta?.outputBytes).toBeGreaterThan(0)
  })

  it('远程客户端抛异常 → 兜成 internal 结论，旁证照样落地', async () => {
    const { gateway, metas } = makeGateway(async () => {
      throw new Error('socket hang up')
    })

    const outcome = await gateway.invoke(spec, { command: 'x' }, {
      callId: 'tc_3',
      envelope,
    } as never)

    expect(outcome).toMatchObject({ ok: false, reason: 'internal' })
    expect(metas.take('r_1', 'tc_3')).toMatchObject({ ok: false, reason: 'internal' })
  })
})
