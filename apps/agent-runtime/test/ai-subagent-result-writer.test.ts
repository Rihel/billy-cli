import { describe, expect, it, vi } from 'vitest'
import { SubAgentResultWriter } from '../src/modules/ai/runtime/subagent-result.writer.js'
import type { AgentRuntimeEnvelope } from '../src/modules/ai/core/envelope.js'

/**
 * 子助手结论落盘的**执行面**回归（2026-11-22 实测的坑）。
 *
 * 会话 `pyao4cssrwn3qf291wh8`：工作区是容器（`/workspace`），
 * 旧实现用宿主本地 `FileService` 落盘 → 父 agent 的 `read-file` 报
 * `cat: /workspace/subagents/…: No such file or directory`。
 * 结论必须走与 `read-file` 同一条执行面（能力网关的 `write-file`）。
 */

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  log: () => undefined,
  debug: () => undefined,
}

const envelope = {
  conversationId: 'conv-1',
  workspaceConversationId: 'conv-1',
  parentRunId: 'run-1',
  triggeredBy: 'user-1',
  isAdmin: false,
  fileAccess: 'workspace-write',
  depth: 0,
  agentKey: 'assistant',
  rootAgentKey: 'assistant',
} as unknown as AgentRuntimeEnvelope

const conversations = (workspaceId: string | null) =>
  ({
    findEntity: async () => (workspaceId ? { id: 'conv-1', workspaceId } : null),
  }) as never

const remote = (outcome: unknown) =>
  ({
    supports: () => true,
    invoke: vi.fn(async () => outcome),
  }) as never

describe('SubAgentResultWriter', () => {
  it('接了能力网关：结论走 write-file，按会话工作区路由（容器 / 远程）', async () => {
    const invoke = vi.fn(async () => ({ ok: true, data: { path: 'x', bytes: 1 } }))
    const writeFile = vi.fn()
    const writer = new SubAgentResultWriter(
      silentLogger as never,
      conversations('ws-1'),
      { supports: () => true, invoke } as never,
      { writeFile } as never,
    )

    const text = '结论\n第二行'
    const out = await writer.write(envelope, '架构分层评审', 'sub-run-1', text)

    expect(out).toEqual({
      path: 'subagents/架构分层评审-sub-run-1.md',
      bytes: Buffer.byteLength(text, 'utf8'),
      lines: 2,
    })
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        toolKey: 'write-file',
        workspaceId: 'ws-1',
        workspaceConversationId: 'conv-1',
        input: { filePath: 'subagents/架构分层评审-sub-run-1.md', content: text },
      }),
    )
    // 绝不往宿主本地写（那是父 agent 读不到的那份）
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('网关在但写失败：返回 null，不回落本地（不给假路径）', async () => {
    const writeFile = vi.fn()
    const writer = new SubAgentResultWriter(
      silentLogger as never,
      conversations('ws-1'),
      remote({ ok: false, reason: 'exec-failed', message: '工作区不可用', retryable: true }),
      { writeFile } as never,
    )

    expect(await writer.write(envelope, '安全评审', 'sub-run-2', '正文')).toBeNull()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('未接能力网关（自托管）：回落本地 FileService', async () => {
    const writeFile = vi.fn(async () => ({ bytes: 12, lines: 3 }))
    const writer = new SubAgentResultWriter(
      silentLogger as never,
      conversations('ws-1'),
      undefined,
      { writeFile } as never,
    )

    const out = await writer.write(envelope, '代码质量评审', 'sub-run-3', '正文')

    expect(out).toEqual({ path: 'subagents/代码质量评审-sub-run-3.md', bytes: 12, lines: 3 })
    expect(writeFile).toHaveBeenCalledTimes(1)
  })

  it('空正文不落盘（不产生空文件）', async () => {
    const invoke = vi.fn()
    const writer = new SubAgentResultWriter(
      silentLogger as never,
      conversations('ws-1'),
      { supports: () => true, invoke } as never,
      undefined,
    )

    expect(await writer.write(envelope, '空结论', 'sub-run-4', '   ')).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })
})
