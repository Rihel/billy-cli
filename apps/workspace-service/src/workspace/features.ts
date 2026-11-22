import type { WorkspaceConfig, WorkspaceFeatures } from '@repo/contracts'

/**
 * 工作区的**执行环境声明**（`docs/design/workspace-env-contract.md` §3 / §4）。
 *
 * 纯函数：只看「工作区配置 + 部署配置 + 平台」，不探测、不建环境、不读盘。
 * 于是建会话时就能算出来（会话创建时一定已绑定工作区），不需要先起容器。
 *
 * 口径：
 * - **容器**（docker / k8s）：`/bin/sh`，容器本身就是边界；能写 HOME、能装全局包；数据不持久；
 *   有资源限额；多副本仅 k8s（同宿主 docker 需显式开关）。
 * - **Host**：命令由宿主 shell 解释（Windows = cmd）；开沙箱时只能写工作区与缓存、默认断网、
 *   不能装全局包；不开沙箱时等于以服务进程身份执行，`writeHome` / `installGlobal` 随之为真；
 *   数据持久，没有资源限额，不支持多副本。
 */
export interface FeaturesInput {
  backend: WorkspaceConfig['backend']
  containerRuntime: 'docker' | 'kubernetes'
  /** 容器网络出口（`bridge` = 可出网；`none` = 断网） */
  containerNetwork: 'bridge' | 'none'
  /** 部署侧沙箱开关 */
  sandboxEnabled: boolean
  /** 工作区显式指定的驱动（空 = 按 backend + 部署默认推导） */
  driver?: 'host' | 'container' | 'pod'
  /** 同宿主 Docker 多副本开关 */
  allowSharedDocker: boolean
  /** 多副本开关 */
  multiInstance: boolean
  /** 平台（测试可注入；缺省取进程平台） */
  platform?: NodeJS.Platform
}

export const featuresOf = (input: FeaturesInput): WorkspaceFeatures => {
  if (input.backend === 'microvm') {
    throw new Error('microvm 后端未实现，没有环境声明')
  }

  if (input.backend === 'container') {
    return {
      shell: 'sh',
      // 容器本身是边界，不再套系统沙箱
      sandbox: 'none',
      network: input.containerNetwork === 'none' ? 'deny' : 'allow',
      writeHome: true,
      installGlobal: true,
      persistence: 'ephemeral',
      resourceLimits: true,
      extraReadRoots: false,
      multiInstance:
        input.containerRuntime === 'kubernetes'
          ? input.multiInstance
          : input.allowSharedDocker && input.multiInstance,
    }
  }

  const platform = input.platform ?? process.platform
  // Windows 没有系统沙箱：即使配了开沙箱，也只能落到「无隔离」
  const sandboxed = input.sandboxEnabled && platform !== 'win32'

  return {
    shell: platform === 'win32' ? 'cmd' : 'sh',
    sandbox: sandboxed ? 'os' : 'none',
    // 沙箱默认断网；不开沙箱时没有网络边界
    network: input.sandboxEnabled ? 'deny' : 'allow',
    // 沙箱只允许写工作区与缓存，所以 HOME 不可写、全局目录不可写
    writeHome: !sandboxed,
    installGlobal: !sandboxed,
    persistence: 'durable',
    resourceLimits: false,
    extraReadRoots: false,
    multiInstance: false,
  }
}

/** 环境类型：Host = 宿主进程；docker / kubernetes = 容器驱动 */
export type EnvironmentKind = 'host' | 'container' | 'pod'

export interface ResolvedEnvironment {
  kind: EnvironmentKind
  features: WorkspaceFeatures
}

/**
 * 按**工作区配置**解析环境（`docs/design/workspace-env-contract.md` §3 的注册点）。
 *
 * 现在容器驱动仍是部署级二选一（`containerRuntime`），但这个函数是「按工作区选驱动」的入口：
 * 以后要支持混合部署，只改这里，运行时的分支不用动。
 */
export const resolveEnvironmentOf = (input: FeaturesInput): ResolvedEnvironment => {
  const derived: EnvironmentKind = input.backend === 'container' ? 'container' : 'host'
  const kind = input.driver ?? derived
  // 防御：工作区字段与 backend 冲突时宁可报错，不悄悄跑错驱动
  if (kind === 'host' && input.backend !== 'local') {
    throw new Error(`工作区驱动（host）与后端（${input.backend}）不一致`)
  }
  if (kind !== 'host' && input.backend !== 'container') {
    throw new Error(`工作区驱动（${kind}）要求 container 后端，实际是 ${input.backend}`)
  }
  // 声明里的「多副本」等判断仍看实际容器运行时：driver=pod 就是 kubernetes
  const effectiveRuntime =
    kind === 'pod' ? 'kubernetes' : kind === 'container' ? 'docker' : input.containerRuntime
  return { kind, features: featuresOf({ ...input, containerRuntime: effectiveRuntime }) }
}
