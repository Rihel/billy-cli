import type { Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControlController } from '../src/agent/agent-control.controller.js'

/**
 * 快照代理的健壮性（2026-11-17 上游 Issue 3）。
 *
 * runtime 回 200 但 body 是空 / 被截断时，早先直接 `JSON.parse(body)` 会抛
 * `Unexpected end of JSON input`，被 Nest 兜成 500 —— 前端把"没有快照"当成了服务端故障。
 * 现在按"这次没有快照"（`data: null`）返回：前端拿到 null 不会点亮恢复灯。
 */

const response = () => {
  const bodies: unknown[] = []
  const statuses: number[] = []
  const res = {
    statused: 200,
    status(code: number) {
      res.statused = code
      statuses.push(code)
      return res
    },
    json(payload: unknown) {
      bodies.push(payload)
      return res
    },
  }
  Object.defineProperty(res, 'bodies', { value: bodies })
  Object.defineProperty(res, 'statuses', { value: statuses })
  return res as unknown as Response & { bodies: unknown[]; statuses: number[] }
}

const upstream = (init: { status: number; body: string }) =>
  ({
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    text: async () => init.body,
  }) as unknown as globalThis.Response

const controllerOf = (init: { status: number; body: string }) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => upstream(init)),
  )
  return new AgentControlController({} as never)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AgentControlController 快照代理', () => {
  it('200 + 空 body：回 data: null，不是 500', async () => {
    const res = response()
    await controllerOf({ status: 200, body: '' }).snapshotCurrent('conv_1', res)

    expect(res.statuses).toEqual([])
    expect(res.bodies).toEqual([{ code: 0, data: null }])
  })

  it('200 + 被截断的 JSON：同样回 data: null', async () => {
    const res = response()
    await controllerOf({ status: 200, body: '{"runId":"run_1","par' }).snapshotCurrent(
      'conv_1',
      res,
    )

    expect(res.statuses).toEqual([])
    expect(res.bodies).toEqual([{ code: 0, data: null }])
  })

  it('200 + 正常 JSON：原样透传给前端', async () => {
    const res = response()
    await controllerOf({ status: 200, body: '{"runId":"run_1","rev":3}' }).snapshotCurrent(
      'conv_1',
      res,
    )

    expect(res.bodies).toEqual([{ code: 0, data: { runId: 'run_1', rev: 3 } }])
  })

  it('204（没有进行中的流）：仍是 data: null 的信封', async () => {
    const res = response()
    await controllerOf({ status: 204, body: '' }).snapshotCurrent('conv_1', res)

    expect(res.bodies).toEqual([{ code: 0, data: null }])
  })

  it('上游失败：透传状态码与错误文案', async () => {
    const res = response()
    await controllerOf({ status: 502, body: '' }).snapshotCurrent('conv_1', res)

    expect(res.statuses).toEqual([502])
    expect(res.bodies).toEqual([{ message: 'agent-runtime 调用失败' }])
  })
})
