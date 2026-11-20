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
    listContainerWorkspaceIds: vi.fn(async () => [] as string[]),
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
  // 初始化阶段单独有测试；这里只验证运行时的执行语义
  const setup = {
    run: vi.fn(async () => ({
      env: {},
      report: {
        setupId: 'default',
        hash: 'x',
        durationMs: 0,
        packages: [],
        skills: [],
        credentials: [],
      },
    })),
  }
  return {
    runtime: new WorkspaceRuntime(
      repo as never,
      sandbox as never,
      config as never,
      setup as never,
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

/** 造一个 container 后端的 runtime + 可编程的假驱动 */
const makeContainer = (running: readonly string[]) => {
  const alive = new Set(running)
  const removed: string[] = []
  const driver = {
    kind: 'docker' as const,
    inspect: vi.fn(async (name: string) =>
      alive.has(name) ? { running: true, startedAt: Date.now() - 3_600_000 } : { running: false },
    ),
    exists: vi.fn(async (name: string) => alive.has(name)),
    start: vi.fn(async () => undefined),
    exec: vi.fn(async () => ({
      code: 0,
      stdout: '',
      stderr: '',
      durationMs: 1,
      timedOut: false,
    })),
    remove: vi.fn(async (name: string) => {
      alive.delete(name)
      removed.push(name)
    }),
  }
  const repo = {
    findConfig: vi.fn(async (id: string) => ({
      id,
      name: 'test',
      backend: 'container' as const,
      location: {},
      fileAccess: 'write' as const,
    })),
    listContainerWorkspaceIds: vi.fn(async () => ['ws-a', 'ws-b']),
    listVisibleSkills: vi.fn(async () => []),
    findSetupContext: vi.fn(async () => null),
    listActiveCredentialVersions: vi.fn(async () => []),
  }
  const config = {
    internalToken: 'test-token',
    defaultImage: 'billy-workspace:test',
    containerRuntime: 'docker' as const,
    kubectlBin: 'kubectl',
    k8sNamespace: '',
    containerMemory: '1g',
    containerCpus: '1',
    containerPidsLimit: 64,
    idleTimeoutMs: 10,
    reapIntervalMs: 1_000,
    localRoot: '/tmp',
  }
  const logger = { info: vi.fn(), warn: vi.fn(), log: vi.fn(), error: vi.fn() }
  const setup = {
    run: vi.fn(async () => ({ env: {}, report: null, manifest: [] })),
    syncCredentials: vi.fn(async () => ({ env: {}, version: 'v1', report: null, manifest: [] })),
  }
  return {
    runtime: new WorkspaceRuntime(
      repo as never,
      { exec: vi.fn() } as never,
      config as never,
      setup as never,
      logger as never,
      driver as never,
    ),
    driver,
    logger,
  }
}

describe('WorkspaceRuntime（container 后端：凭据同步不拉起容器）', () => {
  it('容器不在跑 → 同步失败，且绝不 start', async () => {
    const { runtime, driver } = makeContainer([])

    await expect(runtime.syncCredentials('ws-a')).rejects.toThrow('工作区没有在运行')
    expect(driver.start).not.toHaveBeenCalled()
  })

  it('容器在跑 → 直接认领并落地凭据，不 start', async () => {
    const { runtime, driver } = makeContainer(['billy-ws-ws-a'])

    const result = await runtime.syncCredentials('ws-a', 'v1')

    expect(driver.start).not.toHaveBeenCalled()
    expect(result.credentialVersion).toBe('v1')
  })
})

describe('WorkspaceRuntime（container 后端：孤儿认领）', () => {
  it('重启后把还在跑的容器认领回来，状态是 running', async () => {
    const { runtime } = makeContainer(['billy-ws-ws-a'])
    const adopted = await runtime.reconcile()
    expect(adopted).toBe(1)
    expect((await runtime.status('ws-a')).state).toBe('running')
  })

  it('没在跑的容器不认领', async () => {
    const { runtime } = makeContainer([])
    expect(await runtime.reconcile()).toBe(0)
    expect((await runtime.status('ws-b')).state).toBe('stopped')
  })

  it('认领之后能被回收器扫到并回收（修复前这些容器永不回收）', async () => {
    const { runtime, driver } = makeContainer(['billy-ws-ws-a'])
    const now = Date.now()
    // 启动时认领一次，之后隔一个 idle 窗口再回收
    await runtime.reconcile(now)
    const reaped = await runtime.reapIdle(now + 60_000)
    expect(reaped).toBe(1)
    expect(driver.remove).toHaveBeenCalledWith('billy-ws-ws-a')
    expect((await runtime.status('ws-a')).state).toBe('stopped')
  })
})
