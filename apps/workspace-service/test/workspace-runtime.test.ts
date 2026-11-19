import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceRuntime } from '../src/workspace/workspace-runtime.service.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const make = async (): Promise<{ runtime: WorkspaceRuntime; root: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'ws-runtime-'))
  cleanup.push(root)
  const repo = {
    findConfig: vi.fn(async (id: string) => ({
      id,
      name: 'test',
      backend: 'local' as const,
      location: { root: id },
      fileAccess: 'write' as const,
    })),
  }
  const sandbox = {
    exec: vi.fn(async () => ({
      ok: true,
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      durationMs: 1,
      truncated: false,
    })),
  }
  const config = {
    internalToken: 'test-token',
    defaultImage: 'billy-workspace:test',
    dockerBin: 'docker',
    containerMemory: '1g',
    containerCpus: '1',
    containerPidsLimit: 64,
    idleTimeoutMs: 10,
    reapIntervalMs: 1_000,
    localRoot: root,
  }
  const logger = { info: vi.fn(), warn: vi.fn(), log: vi.fn(), error: vi.fn() }
  return {
    runtime: new WorkspaceRuntime(
      repo as never,
      sandbox as never,
      config as never,
      logger as never,
    ),
    root,
  }
}

describe('WorkspaceRuntime（local 后端）', () => {
  it('ensure 建立工作区并返回 running', async () => {
    const { runtime } = await make()
    const result = await runtime.ensure('ws-a')
    expect(result.state).toBe('running')
  })

  it('写文件后能读回、能列出', async () => {
    const { runtime } = await make()
    const id = 'ws-b'
    const write = await runtime.fs(id, {
      workspaceId: id,
      op: 'write',
      path: 'note.txt',
      content: 'hello',
    })
    expect(write.ok).toBe(true)

    const read = await runtime.fs(id, { workspaceId: id, op: 'read', path: 'note.txt' })
    expect(read.ok).toBe(true)
    expect((read.data as { content: string }).content).toBe('hello')

    const list = await runtime.fs(id, { workspaceId: id, op: 'list', path: '.' })
    expect(list.ok).toBe(true)
    expect((list.data as { entries: { name: string }[] }).entries.map((e) => e.name)).toContain(
      'note.txt',
    )
  })

  it('越界路径被拒绝', async () => {
    const { runtime } = await make()
    const id = 'ws-c'
    const result = await runtime.fs(id, { workspaceId: id, op: 'read', path: '../etc/passwd' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('unsafe-path')
  })

  it('exec 走沙箱并回显 runtime', async () => {
    const { runtime } = await make()
    const result = await runtime.exec('ws-d', { workspaceId: 'ws-d', command: 'echo ok' })
    expect(result.ok).toBe(true)
    expect(result.runtime).toBe('sandbox')
  })

  it('空闲超过阈值会被回收', async () => {
    const { runtime } = await make()
    await runtime.ensure('ws-e')
    const count = await runtime.reapIdle(Date.now() + 60_000)
    expect(count).toBe(1)
    const status = await runtime.status('ws-e')
    expect(status.state).toBe('stopped')
  })
})
