import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { IdGeneration, RedisLockService, RedisStore } from '@repo/kits'
import { WorkspaceCoordinator } from '../src/workspace/workspace-coordinator.js'
import { WorkspaceRuntime } from '../src/workspace/workspace-runtime.service.js'

process.env.REDIS_URL ??= 'redis://localhost:6379/15'

const silentLogger = {
  info: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async (check: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await sleep(5)
  }
  throw new Error('等待超时')
}

let store: RedisStore
let lock: RedisLockService

beforeAll(async () => {
  store = new RedisStore(
    { url: process.env.REDIS_URL, keyPrefix: `wsmulti:${randomUUID()}:` } as never,
    new IdGeneration(),
    silentLogger,
  )
  await store.onApplicationBootstrap()
  lock = new RedisLockService(store, new IdGeneration(), silentLogger)
})

afterAll(async () => {
  await store.close()
})

interface Harness {
  a: WorkspaceRuntime
  b: WorkspaceRuntime
  workspaceId: string
  driver: {
    start: ReturnType<typeof vi.fn>
    remove: ReturnType<typeof vi.fn>
    exec: ReturnType<typeof vi.fn>
    activeExec: () => number
    maxExec: () => number
  }
  setup: { run: ReturnType<typeof vi.fn>; syncCredentials: ReturnType<typeof vi.fn> }
  holdExec: () => void
  releaseExec: () => void
}

const makeHarness = (): Harness => {
  const workspaceId = `ws-${randomUUID()}`
  const alive = new Set<string>()
  let activeExec = 0
  let maxExec = 0
  let execGate: Promise<void> = Promise.resolve()
  let releaseGate = (): void => undefined

  const holdExec = (): void => {
    execGate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
  }

  const driver = {
    kind: 'docker' as const,
    inspect: vi.fn(async (name: string) => ({ running: alive.has(name) })),
    exists: vi.fn(async (name: string) => alive.has(name)),
    imageOf: vi.fn(async () => 'billy-workspace:test'),
    start: vi.fn(async ({ name }: { name: string }) => {
      alive.add(name)
    }),
    exec: vi.fn(async () => {
      activeExec += 1
      maxExec = Math.max(maxExec, activeExec)
      try {
        await execGate
      } finally {
        activeExec -= 1
      }
      return { code: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false }
    }),
    remove: vi.fn(async (name: string) => {
      alive.delete(name)
    }),
  }

  const repo = {
    findConfig: vi.fn(async () => ({
      id: workspaceId,
      name: 'test',
      backend: 'container' as const,
      location: {},
      fileAccess: 'write' as const,
    })),
    listContainerWorkspaceIds: vi.fn(async () => [{ id: workspaceId, runtime: 'docker' as const }]),
  }
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
  const config = {
    internalToken: 'test',
    defaultImage: 'billy-workspace:test',
    containerRuntime: 'docker' as const,
    multiInstance: true,
    allowSharedDocker: true,
    kubectlBin: 'kubectl',
    k8sNamespace: '',
    containerMemory: '1g',
    containerCpus: '1',
    containerPidsLimit: 64,
    idleTimeoutMs: 10,
    reapIntervalMs: 1_000,
    localRoot: '/tmp',
  }
  const makeRuntime = (coordinator: WorkspaceCoordinator): WorkspaceRuntime =>
    new WorkspaceRuntime(
      repo as never,
      { exec: vi.fn() } as never,
      config as never,
      setup as never,
      {
        info: vi.fn(),
        warn: vi.fn(),
        log: vi.fn(),
        error: vi.fn(),
      } as never,
      driver as never,
      coordinator,
    )

  return {
    a: makeRuntime(new WorkspaceCoordinator(lock, store)),
    b: makeRuntime(new WorkspaceCoordinator(lock, store)),
    workspaceId,
    driver: {
      start: driver.start,
      remove: driver.remove,
      exec: driver.exec,
      activeExec: () => activeExec,
      maxExec: () => maxExec,
    },
    setup,
    holdExec,
    releaseExec: () => releaseGate(),
  }
}

describe('WorkspaceRuntime（同宿主 Docker 多副本）', () => {
  it('两个副本并发首次 ensure 只 start 一次、setup 只跑一次', async () => {
    const { a, b, workspaceId, driver, setup } = makeHarness()

    await Promise.all([a.ensure(workspaceId), b.ensure(workspaceId)])

    expect(driver.start).toHaveBeenCalledTimes(1)
    expect(setup.run).toHaveBeenCalledTimes(1)
  })

  it('两个副本并发 exec 同一 workspace：驱动侧最大并发为 1', async () => {
    const { a, b, workspaceId, driver, holdExec, releaseExec } = makeHarness()
    await a.ensure(workspaceId)
    holdExec()

    const first = a.exec(workspaceId, { workspaceId, command: 'a' })
    const second = b.exec(workspaceId, { workspaceId, command: 'b' })
    await waitFor(() => driver.activeExec() === 1)
    await sleep(30)
    // 第二个还在等 Redis exec 锁，没有进到 driver
    expect(driver.exec).toHaveBeenCalledTimes(1)

    releaseExec()
    await Promise.all([first, second])
    expect(driver.maxExec()).toBe(1)
  })

  it('回收器在另一个副本持 exec 锁时跳过；释放后才回收', async () => {
    const { a, b, workspaceId, driver, holdExec, releaseExec } = makeHarness()
    await a.ensure(workspaceId)
    holdExec()

    const running = a.exec(workspaceId, { workspaceId, command: 'long' })
    await waitFor(() => driver.activeExec() === 1)

    expect(await b.reapIdle(Date.now() + 1_000)).toBe(0)
    expect(driver.remove).not.toHaveBeenCalled()

    releaseExec()
    await running
    expect(await b.reapIdle(Date.now() + 1_000)).toBe(1)
    expect(driver.remove).toHaveBeenCalledTimes(1)
  })
})
