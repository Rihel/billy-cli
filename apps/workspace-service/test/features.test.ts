import { describe, expect, it } from 'vitest'
import { featuresOf, resolveEnvironmentOf } from '../src/workspace/features.js'

/**
 * 执行环境声明（`docs/design/workspace-env-contract.md`）的固定口径。
 *
 * 这张表是「上层按声明做事」的事实源：工具、初始化、提示词都读它，
 * 所以每个分支都要钉死，避免以后有人顺手改一个值、行为悄悄变了。
 */
const base = {
  containerRuntime: 'docker' as const,
  containerNetwork: 'bridge' as const,
  sandboxEnabled: true,
  allowSharedDocker: false,
  multiInstance: false,
}

describe('featuresOf：Host', () => {
  it('Linux + 开沙箱：sh、系统沙箱、断网、不能写 HOME / 装全局、数据持久、无资源限额', () => {
    expect(featuresOf({ ...base, backend: 'local', platform: 'linux' })).toEqual({
      shell: 'sh',
      sandbox: 'os',
      network: 'deny',
      writeHome: false,
      installGlobal: false,
      persistence: 'durable',
      resourceLimits: false,
      extraReadRoots: false,
      multiInstance: false,
    })
  })

  it('Windows + 开沙箱：仍然只能无隔离（platform 没有系统沙箱），shell 变 cmd', () => {
    expect(featuresOf({ ...base, backend: 'local', platform: 'win32' })).toMatchObject({
      shell: 'cmd',
      sandbox: 'none',
      network: 'deny',
      // 没有沙箱 → HOME 与全局目录都写得进去
      writeHome: true,
      installGlobal: true,
    })
  })

  it('关闭沙箱：无隔离、可出网、可写 HOME / 装全局包', () => {
    expect(
      featuresOf({ ...base, backend: 'local', platform: 'linux', sandboxEnabled: false }),
    ).toMatchObject({
      shell: 'sh',
      sandbox: 'none',
      network: 'allow',
      writeHome: true,
      installGlobal: true,
      persistence: 'durable',
    })
  })

  it('Host 永远不支持多副本', () => {
    expect(
      featuresOf({ ...base, backend: 'local', platform: 'linux', multiInstance: true }),
    ).toMatchObject({ multiInstance: false })
  })
})

describe('featuresOf：容器', () => {
  it('docker + bridge：sh、容器边界、可出网、可写 HOME / 装全局、数据不持久、有资源限额', () => {
    expect(featuresOf({ ...base, backend: 'container' })).toEqual({
      shell: 'sh',
      sandbox: 'none',
      network: 'allow',
      writeHome: true,
      installGlobal: true,
      persistence: 'ephemeral',
      resourceLimits: true,
      extraReadRoots: false,
      multiInstance: false,
    })
  })

  it('断网容器：network = deny', () => {
    expect(featuresOf({ ...base, backend: 'container', containerNetwork: 'none' })).toMatchObject({
      network: 'deny',
    })
  })

  it('多副本：k8s 支持；同宿主 docker 需要显式开关', () => {
    expect(
      featuresOf({
        ...base,
        backend: 'container',
        containerRuntime: 'kubernetes',
        multiInstance: true,
      }),
    ).toMatchObject({ multiInstance: true })
    expect(featuresOf({ ...base, backend: 'container', multiInstance: true })).toMatchObject({
      multiInstance: false,
    })
    expect(
      featuresOf({
        ...base,
        backend: 'container',
        multiInstance: true,
        allowSharedDocker: true,
      }),
    ).toMatchObject({ multiInstance: true })
  })
})

describe('featuresOf：未实现的引擎', () => {
  it('microvm 直接报错，不编造声明', () => {
    expect(() => featuresOf({ ...base, backend: 'microvm' })).toThrow(/未实现/)
  })
})

describe('resolveEnvironmentOf：按工作区解析环境类型', () => {
  const baseEnv = {
    containerNetwork: 'bridge' as const,
    sandboxEnabled: true,
    allowSharedDocker: false,
    multiInstance: false,
  }

  it('工作区显式 driver 覆盖推导值，且与 backend 不符时直接报错', () => {
    expect(
      resolveEnvironmentOf({
        ...baseEnv,
        backend: 'container',
        driver: 'pod',
      }).kind,
    ).toBe('pod')
    expect(() =>
      resolveEnvironmentOf({ ...baseEnv, backend: 'local', driver: 'container' }),
    ).toThrow(/要求 container 后端/)
    expect(() =>
      resolveEnvironmentOf({ ...baseEnv, backend: 'container', driver: 'host' }),
    ).toThrow(/与后端/)
  })

  it('local → host；container → container（Docker）', () => {
    expect(
      resolveEnvironmentOf({ ...baseEnv, backend: 'local', containerRuntime: 'docker' }).kind,
    ).toBe('host')
    expect(
      resolveEnvironmentOf({ ...baseEnv, backend: 'container', containerRuntime: 'docker' }).kind,
    ).toBe('container')
    expect(resolveEnvironmentOf({ ...baseEnv, backend: 'container', driver: 'pod' }).kind).toBe(
      'pod',
    )
  })
})
