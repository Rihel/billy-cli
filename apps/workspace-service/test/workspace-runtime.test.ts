import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceFsRequest, WorkspaceFsResult } from '@repo/contracts'
import { WorkspaceRuntime } from '../src/workspace/workspace-runtime.service.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const make = async (): Promise<{
  runtime: WorkspaceRuntime
  root: string
  setup: { run: ReturnType<typeof vi.fn>; syncCredentials: ReturnType<typeof vi.fn> }
}> => {
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
      manifest: [],
      resolved: true,
    })),
    syncCredentials: vi.fn(async () => ({
      env: {},
      version: '0',
      report: {
        setupId: 'default',
        hash: 'x',
        durationMs: 0,
        packages: [],
        skills: [],
        credentials: [],
      },
      manifest: [],
      resolved: true,
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
    setup,
  }
}

describe('WorkspaceRuntime（local 后端）', () => {
  it('ensure 建立工作区并返回 running', async () => {
    const { runtime } = await make()
    const result = await runtime.ensure('ws-a')
    expect(result.state).toBe('running')
  })

  it('并发首次 ensure 只初始化一次（singleflight）', async () => {
    const { runtime, setup } = await make()

    await Promise.all([runtime.ensure('ws-sf'), runtime.ensure('ws-sf')])

    expect(setup.run).toHaveBeenCalledTimes(1)
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
const makeContainer = (running: readonly string[], coordinator?: never) => {
  const alive = new Set(running)
  const removed: string[] = []
  const driver = {
    kind: 'docker' as const,
    inspect: vi.fn(async (name: string) =>
      alive.has(name) ? { running: true, startedAt: Date.now() - 3_600_000 } : { running: false },
    ),
    exists: vi.fn(async (name: string) => alive.has(name)),
    imageOf: vi.fn(async () => 'billy-workspace:test'),
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
    run: vi.fn(async () => ({ env: {}, report: null, manifest: [], resolved: true })),
    syncCredentials: vi.fn(async () => ({
      env: {},
      version: 'v1',
      report: null,
      manifest: [],
      resolved: true,
    })),
  }
  return {
    runtime: new WorkspaceRuntime(
      repo as never,
      { exec: vi.fn() } as never,
      config as never,
      setup as never,
      logger as never,
      driver as never,
      coordinator,
    ),
    driver,
    logger,
    setup,
  }
}

describe('WorkspaceRuntime（container 后端：已有容器不重复初始化）', () => {
  it('容器已在跑 → 只补凭据段，不重跑装包 / 技能', async () => {
    const { runtime, setup } = makeContainer(['billy-ws-ws-a'])

    const status = await runtime.ensure('ws-a')

    expect(status.state).toBe('running')
    expect(setup.run).not.toHaveBeenCalled()
    expect(setup.syncCredentials).toHaveBeenCalledTimes(1)
  })
})

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

describe('WorkspaceRuntime（凭据清单与补偿，issue 9）', () => {
  const item = { provider: 'github', name: 'gh', expiresAt: null }
  const manifestOf = (items: { provider: string; name: string; expiresAt: string | null }[]) =>
    JSON.stringify({ version: '1-1', items })

  it('清单是 JSON 文本：读出来必须 parse（不能把 fs 出参当结构）', async () => {
    const { runtime, setup } = await make()
    // 模拟"初始化 / 补偿暂时都拿不到凭据"：缓存不落地，只能读磁盘
    setup.run.mockRejectedValue(new Error('main 还没就绪'))
    setup.syncCredentials.mockRejectedValue(new Error('main 还没就绪'))
    const id = 'ws-manifest'
    await runtime.fs(id, {
      workspaceId: id,
      op: 'write',
      path: '.billy/credentials.json',
      content: manifestOf([item]),
    })

    // 修复前：把 fs 出参直接当清单 → items 永远空 → 有凭据也被拒
    expect(await runtime.authorizeCommand(id, 'gh pr list')).toBeNull()
  })

  it('读失败不缓存空清单：后来写上的清单立刻生效（阴性缓存中毒）', async () => {
    const { runtime, setup } = await make()
    setup.run.mockRejectedValue(new Error('main 还没就绪'))
    setup.syncCredentials.mockRejectedValue(new Error('main 还没就绪'))
    const id = 'ws-negative'

    const denied = await runtime.authorizeCommand(id, 'gh pr list')
    expect(denied?.denial).toMatchObject({ provider: 'github', reason: 'missing' })

    await runtime.fs(id, {
      workspaceId: id,
      op: 'write',
      path: '.billy/credentials.json',
      content: manifestOf([item]),
    })
    expect(await runtime.authorizeCommand(id, 'gh pr list')).toBeNull()
  })

  it('解析失败不覆盖已有好状态：空清单不会冲掉已落地的凭据', async () => {
    const { runtime, setup } = makeContainer(['billy-ws-ws-a'])
    setup.syncCredentials.mockResolvedValueOnce({
      env: { GH_TOKEN: 't' },
      version: '1-1',
      report: null,
      manifest: [item],
      resolved: true,
    })
    await runtime.syncCredentials('ws-a')
    // 之后一直是暂态失败（包括 ensure 触发的补偿）
    setup.syncCredentials.mockResolvedValue({
      env: {},
      version: '0',
      report: null,
      manifest: [],
      resolved: false,
    })
    await runtime.syncCredentials('ws-a')

    // 上一份好清单还在 → 门照常放行（暂态失败不能变成永久拒绝）
    expect(await runtime.authorizeCommand('ws-a', 'gh pr list')).toBeNull()
  })

  it('认领的 handle 凭据未就绪 → 拒绝标为暂态，调用方据此给 retryable', async () => {
    const { runtime, setup } = makeContainer(['billy-ws-ws-a'])
    setup.syncCredentials.mockResolvedValue({
      env: {},
      version: '0',
      report: null,
      manifest: [],
      resolved: false,
    })
    await runtime.reconcile()

    const gate = await runtime.authorizeCommand('ws-a', 'gh pr list')

    expect(gate?.denial.reason).toBe('missing')
    expect(gate?.transient).toBe(true)
  })
})

/** 容器后端：记录驱动里的在跑命令数，验证"按工作区串行" */
const makeSerialContainer = () => {
  const inflight = { now: 0, max: 0 }
  const driver = {
    kind: 'docker' as const,
    inspect: vi.fn(async () => ({ running: true })),
    imageOf: vi.fn(async () => 'billy-workspace:test'),
    exists: vi.fn(async () => true),
    start: vi.fn(async () => undefined),
    exec: vi.fn(async () => {
      inflight.now += 1
      inflight.max = Math.max(inflight.max, inflight.now)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inflight.now -= 1
      return { code: 0, stdout: '', stderr: '', durationMs: 10, timedOut: false }
    }),
    remove: vi.fn(async () => undefined),
  }
  const repo = {
    findConfig: vi.fn(async (id: string) => ({
      id,
      name: 'test',
      backend: 'container' as const,
      location: {},
      fileAccess: 'write' as const,
    })),
    listContainerWorkspaceIds: vi.fn(async () => []),
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
      manifest: [],
      resolved: true,
    })),
    syncCredentials: vi.fn(async () => ({
      env: {},
      version: 'v1',
      report: {
        setupId: 'default',
        hash: 'x',
        durationMs: 0,
        packages: [],
        skills: [],
        credentials: [],
      },
      manifest: [],
      resolved: true,
    })),
  }
  const logger = { info: vi.fn(), warn: vi.fn(), log: vi.fn(), error: vi.fn() }
  const runtime = new WorkspaceRuntime(
    repo as never,
    { exec: vi.fn() } as never,
    config as never,
    setup as never,
    logger as never,
    driver as never,
  )
  return { runtime, inflight }
}

describe('WorkspaceRuntime（多副本回收）', () => {
  it('按 Redis 共享 lastUsed 回收；exec 锁被占时跳过', async () => {
    const now = Date.now()
    let execBusy = true
    const coordinator = {
      distributed: true,
      withLock: async <T>(_kind: string, _id: string, task: () => Promise<T>) => task(),
      tryWithLock: async <T>(kind: string, _id: string, task: () => Promise<T>) => {
        if (kind === 'exec' && execBusy) return { acquired: false as const }
        return { acquired: true as const, result: await task() }
      },
      lastUsed: async () => now - 60_000,
      touch: async () => undefined,
      clear: async () => undefined,
    }
    const { runtime, driver } = makeContainer(['billy-ws-ws-a'], coordinator as never)

    expect(await runtime.reapIdle(now)).toBe(0)
    expect(driver.remove).not.toHaveBeenCalled()

    execBusy = false
    expect(await runtime.reapIdle(now)).toBe(1)
    expect(driver.remove).toHaveBeenCalledWith('billy-ws-ws-a')
  })
})

describe('执行面串行（docs/design/workspace.md §8）', () => {
  it('同一工作区的 bash 一次只跑一条（并发三路 → 最大并发 1）', async () => {
    const { runtime, inflight } = makeSerialContainer()

    await Promise.all([
      runtime.exec('ws-s', { workspaceId: 'ws-s', command: 'a' }),
      runtime.exec('ws-s', { workspaceId: 'ws-s', command: 'b' }),
      runtime.exec('ws-s', { workspaceId: 'ws-s', command: 'c' }),
    ])

    expect(inflight.max).toBe(1)
  })

  it('不同工作区互不阻塞（两路 → 最大并发 2）', async () => {
    const { runtime, inflight } = makeSerialContainer()

    await Promise.all([
      runtime.exec('ws-x', { workspaceId: 'ws-x', command: 'a' }),
      runtime.exec('ws-y', { workspaceId: 'ws-y', command: 'b' }),
    ])

    expect(inflight.max).toBe(2)
  })
})

describe('同一路径的写按路径串行（主 agent / 子 agent 并发写不互相截断）', () => {
  it('第一路没写完，第二路不会开始', async () => {
    const { runtime } = await make()
    const id = 'ws-lock'
    // 先把 handle 建好：首次 ensure 会跑初始化，两路并发时谁先拿到 handle 不确定，
    // 这里要钉的是"写锁"，不是初始化时序
    await runtime.ensure(id)
    const internals = runtime as unknown as {
      localFs: (root: string, request: WorkspaceFsRequest) => Promise<WorkspaceFsResult>
    }
    const original = internals.localFs.bind(runtime)
    const started: string[] = []
    let release!: (value: WorkspaceFsResult) => void
    const gate = new Promise<WorkspaceFsResult>((resolve) => {
      release = resolve
    })
    internals.localFs = vi.fn(async (root: string, request: WorkspaceFsRequest) => {
      if (request.op === 'write' && request.content === 'first') {
        started.push('first')
        return gate
      }
      started.push(String(request.content ?? request.op))
      return original(root, request)
    })

    const first = runtime.fs(id, {
      workspaceId: id,
      op: 'write',
      path: 'shared.txt',
      content: 'first',
    })
    const second = runtime.fs(id, {
      workspaceId: id,
      op: 'write',
      path: 'shared.txt',
      content: 'second',
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    // 同一把 `workspaceId:path` 锁：第二路还在排队
    expect(started).toEqual(['first'])
    release({ ok: true, data: { path: 'shared.txt' } })
    await Promise.all([first, second])
    expect(started).toEqual(['first', 'second'])
  })
})

describe('写文件原子化：同目录 tmp + rename', () => {
  it('大文件写完不残留临时文件，读回内容完整', async () => {
    const { runtime, root } = await make()
    const id = 'ws-atomic'
    const content = 'x'.repeat(100_000)

    const written = await runtime.fs(id, {
      workspaceId: id,
      op: 'write',
      path: 'dir/big.txt',
      content,
    })
    expect(written.ok).toBe(true)

    const read = await runtime.fs(id, { workspaceId: id, op: 'read', path: 'dir/big.txt' })
    expect((read.data as { content: string }).content).toBe(content)
    expect(await readdir(join(root, id, 'dir'))).toEqual(['big.txt'])
  })
})
