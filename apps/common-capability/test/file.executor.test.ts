import { describe, expect, it, vi } from 'vitest'
import { FileConfigSchema, type FileService } from '@repo/ai-data'
import type { ToolInvokeRequest } from '@repo/contracts'
import { FileExecutor } from '../src/tools/file/file.executor.js'
import type { AppLogger } from '@repo/kits'

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger

const request = (over: Partial<ToolInvokeRequest> = {}): ToolInvokeRequest => ({
  version: 1,
  requestId: 'req-file',
  toolKey: 'file-list',
  toolCallId: 'call-file',
  input: {},
  caller: {
    conversationId: 'c-1',
    runId: 'r-1',
    userId: 'u-1',
    isAdmin: false,
    agentKey: 'assistant',
    rootAgentKey: 'assistant',
    depth: 0,
  },
  settings: {
    config: FileConfigSchema.parse({}),
    limits: {},
    secrets: {},
    version: 'test',
  },
  deadlineMs: 10_000,
  ...over,
})

const build = () => {
  const files = {
    list: vi.fn(async () => ({ files: [] })),
  } as unknown as FileService
  return {
    executor: new FileExecutor(files, {}, logger, {
      workspaceIdOf: async () => null,
      resolve: async () => null,
    } as never),
    files,
  }
}

describe('FileExecutor（直连 FileService）', () => {
  it('file-list 直接调 FileService，不经过 server', async () => {
    const { executor, files } = build()
    const outcome = await executor.fileList(request())
    expect(outcome).toEqual({ ok: true, data: { files: [] } })
    expect(files.list).toHaveBeenCalledWith('c-1')
  })

  it('没有用户身份直接 forbidden', async () => {
    const { executor } = build()
    const outcome = await executor.fileList(
      request({ caller: { ...request().caller, userId: null } }),
    )
    expect(outcome).toMatchObject({ ok: false, reason: 'forbidden' })
  })
})
