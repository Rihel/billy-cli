import { describe, expect, it } from 'vitest'
import {
  TOOL_CONTRACT_VERSION,
  ToolInvokeRequestSchema,
  ToolOutcomeSchema,
  WORKER_STALE_MS,
  WORKERS_ALIVE_KEY,
  workerKey,
} from '../src/index.js'

const base = {
  version: TOOL_CONTRACT_VERSION as 1,
  requestId: 'req-1',
  toolKey: 'bash',
  toolCallId: 'call-1',
  input: { command: 'echo hi' },
  caller: {
    conversationId: 'c-1',
    runId: 'r-1',
    userId: 'u-1',
    agentKey: 'assistant',
    rootAgentKey: 'assistant',
    depth: 0,
  },
  deadlineMs: 15_000,
}

describe('tool 契约', () => {
  it('接受合法请求，允许 toolCallId 为 null', () => {
    expect(ToolInvokeRequestSchema.parse({ ...base, toolCallId: null }).toolKey).toBe('bash')
  })

  it('拒绝错误版本 / 缺少调用方', () => {
    expect(() => ToolInvokeRequestSchema.parse({ ...base, version: 2 })).toThrow(/version/i)
    expect(() => ToolInvokeRequestSchema.parse({ ...base, caller: undefined })).toThrow(/caller/i)
  })

  it('拒绝越界 deadline', () => {
    expect(() => ToolInvokeRequestSchema.parse({ ...base, deadlineMs: 300_001 })).toThrow(
      /deadline/i,
    )
  })

  it('结论是判别联合：ok=false 必须带原因', () => {
    expect(ToolOutcomeSchema.parse({ ok: false, reason: 'denied', message: '不允许' }).ok).toBe(
      false,
    )
    expect(() => ToolOutcomeSchema.parse({ ok: false, message: '缺 reason' })).toThrow(/reason/i)
  })
})

describe('worker 注册键', () => {
  it('key 稳定且可区分', () => {
    expect(workerKey('w-1')).toBe('ai:tool-worker:w-1')
    expect(WORKERS_ALIVE_KEY).toBe('ai:tool-workers:alive')
    expect(WORKER_STALE_MS).toBe(30_000)
  })
})
