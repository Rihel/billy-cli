import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceConfig, WorkspaceFeatures } from '@repo/contracts'
import type { ContainerDriver } from '../src/workspace/container/driver.js'
import { containerFs } from '../src/workspace/fs/container-fs.js'
import { hostFs } from '../src/workspace/fs/host-fs.js'
import { ContainerWorkspaceDriver } from '../src/workspace/environment/container.driver.js'
import { HostWorkspaceDriver } from '../src/workspace/environment/host.driver.js'

/**
 * 驱动层测试（`docs/design/workspace-env-contract.md` §3 / §4）。
 *
 * 钉的是「驱动只做原语」：起停、执行、文件、释放；上层语义（锁 / 初始化 / 回收）不在这里。
 */

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

const FEATURES: WorkspaceFeatures = {
  shell: 'sh',
  sandbox: 'none',
  network: 'allow',
  writeHome: true,
  installGlobal: true,
  persistence: 'ephemeral',
  resourceLimits: true,
  extraReadRoots: false,
  multiInstance: false,
}

const config = (over: Partial<WorkspaceConfig> = {}): WorkspaceConfig => ({
  id: 'ws_1',
  name: 'test',
  backend: 'container',
  fileAccess: 'write',
  ...over,
})

const makeContainerDriver = (over: Partial<ContainerDriver> = {}): ContainerDriver => ({
  kind: 'docker',
  inspect: vi.fn(async () => ({ running: false })),
  exists: vi.fn(async () => false),
  imageOf: vi.fn(async () => null),
  start: vi.fn(async () => undefined),
  exec: vi.fn(async () => ({
    code: 0,
    stdout: 'ok',
    stderr: '',
    durationMs: 1,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  })),
  remove: vi.fn(async () => undefined),
  ...over,
})

const makeContainerEnvironment = (driver: ContainerDriver) =>
  new ContainerWorkspaceDriver({
    driver,
    fs: containerFs,
    features: () => FEATURES,
    defaultImage: 'billy-workspace:test',
    memory: '1g',
    cpus: '1',
    pidsLimit: 64,
    network: 'bridge',
  })

describe('ContainerWorkspaceDriver', () => {
  it('没在跑 → start，started=true；镜像用配置或默认值', async () => {
    const driver = makeContainerDriver()
    const env = makeContainerEnvironment(driver)
    const result = await env.prepare(
      { workspaceId: 'ws_1', root: '/workspace', managed: true, containerName: 'billy-ws-ws_1' },
      config(),
    )

    expect(result.started).toBe(true)
    expect(driver.start).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'billy-workspace:test', network: 'bridge' }),
    )
  })

  it('在跑且镜像一致 → 不重建，started=false', async () => {
    const driver = makeContainerDriver({
      exists: vi.fn(async () => true),
      imageOf: vi.fn(async () => 'billy-workspace:test'),
    })
    const env = makeContainerEnvironment(driver)
    const result = await env.prepare(
      { workspaceId: 'ws_1', root: '/workspace', managed: true, containerName: 'billy-ws-ws_1' },
      config(),
    )

    expect(result.started).toBe(false)
    expect(driver.remove).not.toHaveBeenCalled()
    expect(driver.start).not.toHaveBeenCalled()
  })

  it('在跑但镜像是旧的 → 删了重建（避免跑旧工具链）', async () => {
    const driver = makeContainerDriver({
      exists: vi.fn(async () => true),
      imageOf: vi.fn(async () => 'billy-workspace:old'),
    })
    const env = makeContainerEnvironment(driver)
    const result = await env.prepare(
      { workspaceId: 'ws_1', root: '/workspace', managed: true, containerName: 'billy-ws-ws_1' },
      config({ image: 'billy-workspace:new' }),
    )

    expect(result.started).toBe(true)
    expect(driver.remove).toHaveBeenCalledTimes(1)
    expect(driver.start).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'billy-workspace:new' }),
    )
  })

  it('exec 把结果翻译成统一出参（runtime=container）', async () => {
    const driver = makeContainerDriver({
      exec: vi.fn(async () => ({
        code: 0,
        stdout: 'hi',
        stderr: '',
        durationMs: 5,
        timedOut: false,
        stdoutTruncated: true,
        stderrTruncated: false,
      })),
    })
    const env = makeContainerEnvironment(driver)
    const result = await env.exec(
      { workspaceId: 'ws_1', root: '/workspace', managed: true, containerName: 'c' },
      config(),
      { workspaceId: 'ws_1', command: 'echo hi', cwd: 'sub' },
    )

    expect(result).toMatchObject({ ok: true, stdout: 'hi', runtime: 'container', truncated: true })
    expect(driver.exec).toHaveBeenCalledWith(
      'c',
      expect.objectContaining({ cwd: '/workspace/sub' }),
    )
  })

  it('dispose 直接删容器（容器数据本来就是临时的）', async () => {
    const driver = makeContainerDriver()
    const env = makeContainerEnvironment(driver)
    await env.dispose(
      { workspaceId: 'ws_1', root: '/workspace', managed: true, containerName: 'c' },
      'stop',
    )
    expect(driver.remove).toHaveBeenCalledWith('c')
  })
})

describe('HostWorkspaceDriver', () => {
  const makeHost = (over: { execResult?: Record<string, unknown> } = {}) => {
    const sandbox = {
      status: vi.fn(async () => ({
        mode: 'enforce',
        sandbox: { available: true, impl: 'seatbelt' },
      })),
      exec: vi.fn(async () => ({
        ok: true,
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        durationMs: 1,
        truncated: false,
        ...over.execResult,
      })),
    }
    const env = new HostWorkspaceDriver({
      sandbox: sandbox as never,
      hostFs,
      features: () => ({ ...FEATURES, shell: 'sh', persistence: 'durable' }),
    })
    return { env, sandbox }
  }

  it('prepare：托管目录不存在就建；用户目录不建（必须已存在）', async () => {
    const { env } = makeHost()
    const root = await mkdtemp(join(tmpdir(), 'env-host-'))
    cleanup.push(root)
    const managedRoot = join(root, 'managed')

    await env.prepare({ workspaceId: 'ws', root: managedRoot, managed: true })
    expect(await readdir(managedRoot)).toEqual([])

    const missing = join(root, 'missing')
    await env.prepare({ workspaceId: 'ws', root: missing, managed: false })
    await expect(readdir(missing)).rejects.toThrow('ENOENT')
  })

  it('exec 走沙箱并带上 fileAccess / 超时 / shell 前缀，出参 runtime=sandbox', async () => {
    const { env, sandbox } = makeHost()
    const root = await mkdtemp(join(tmpdir(), 'env-host-'))
    cleanup.push(root)
    await env.exec(
      { workspaceId: 'ws', root, managed: true },
      config({ backend: 'local', fileAccess: 'read-only' }),
      { workspaceId: 'ws', command: 'echo $FOO', cwd: 'sub', env: { FOO: 'a b' } },
    )

    expect(sandbox.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: root,
        cwd: join(root, 'sub'),
        fileAccess: 'read-only',
        command: expect.stringContaining("env 'FOO=a b'"),
      }),
    )
  })

  it('dispose：stop 保留目录，purge 才删', async () => {
    const { env } = makeHost()
    const root = await mkdtemp(join(tmpdir(), 'env-host-'))
    cleanup.push(root)
    await writeFile(join(root, 'a.txt'), 'x')

    await env.dispose({ workspaceId: 'ws', root, managed: true }, 'stop')
    expect(await readdir(root)).toEqual(['a.txt'])

    await env.dispose({ workspaceId: 'ws', root, managed: true }, 'purge')
    await expect(readdir(root)).rejects.toThrow('ENOENT')
  })

  it('probe 映射沙箱状态；沙箱 status 抛错时降级为不可用', async () => {
    const { env } = makeHost()
    await expect(env.probe()).resolves.toEqual({ available: true })

    const broken = new HostWorkspaceDriver({
      sandbox: {
        status: vi.fn(async () => {
          throw new Error('boom')
        }),
      } as never,
      hostFs,
      features: () => FEATURES,
    })
    await expect(broken.probe()).resolves.toEqual({ available: false, reason: 'boom' })
  })
})
