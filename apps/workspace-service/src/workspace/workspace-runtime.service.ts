import { mkdir } from 'node:fs/promises'
import { posix, resolve } from 'node:path'
import { Inject, Injectable, Optional } from '@nestjs/common'
import { AppLogger, describePlatform, WorkspaceRuntimeService as SandboxRuntime } from '@repo/kits'
import type {
  WorkspaceConfig,
  WorkspaceEnvironment,
  WorkspaceFeatures,
  WorkspaceExecRequest,
  WorkspaceExecResult,
  WorkspaceFsRequest,
  WorkspaceFsResult,
  WorkspaceRuntimeState,
  WorkspaceStatusResponse,
} from '@repo/contracts'
import { WorkspaceRepository } from './workspace.repository.js'
import { WorkspaceSetupService } from './setup/setup.service.js'
import { createExecShell, createHostShell } from './setup/shell.js'
import { WorkspaceCoordinator } from './workspace-coordinator.js'
import {
  checkCommandCredentials,
  type CredentialGateDenial,
  type CredentialManifest,
} from './credential/gate.js'
import { DockerDriver, KubernetesDriver, type ContainerDriver } from './container/driver.js'
import { HostRootError, resolveLocalRoot, type LocalRootPlan } from './host-root.js'
import { ContainerWorkspaceDriver } from './environment/container.driver.js'
import { HostWorkspaceDriver } from './environment/host.driver.js'
import type { DriverRef, WorkspaceDriver } from './environment/types.js'
import { containerFs, type ContainerFs } from './fs/container-fs.js'
import { hostFs, type HostFs } from './fs/host-fs.js'
import { resolveEnvironmentOf } from './features.js'
import { WorkspaceServiceConfig, type WorkspaceServiceConfigValue } from '../config/app-config.js'

/** 容器内固定的工作目录（与镜像约定一致） */
const CONTAINER_WORKDIR = '/workspace'

/** 会改动工作区文件的操作：只有它们需要按路径串行（读不排队，靠原子写保证读到的不是半截） */
const MUTATING_FS_OPS = new Set(['write', 'write-bytes', 'append', 'replace', 'remove'])

/** 原子写的临时文件后缀（同目录内 `rename` 才是原子的，不跨目录） */

interface Handle {
  workspaceId: string
  backend: WorkspaceConfig['backend']
  root: string
  /**
   * 平台是否**托管**这个根（`false` = 用户宿主目录）。
   *
   * 托管根跑初始化（装 CLI / 物化 `.agents/` / 写 `.billy/`）；宿主目录不跑，
   * 否则会把平台产物写进用户自己的项目。
   */
  managed?: boolean
  /** 执行环境声明（工具、初始化、提示词都按它做事，见 docs/design/workspace-env-contract.md） */
  features?: WorkspaceFeatures
  /** 容器后端用哪个运行时（docker / kubernetes）；空 = 部署默认 */
  containerRuntime?: 'docker' | 'kubernetes'
  containerName?: string
  startedAt: number
  lastUsedAt: number
  /** 初始化阶段落地的凭据环境变量（每次 exec 注入；P7 的本地清单校验也用它） */
  env?: Record<string, string>
  /** 初始化是否已跑过（含失败；失败不重试，避免每条命令都等一遍安装超时） */
  setupDone?: boolean
  /**
   * **凭据段**是否已成功落地（`undefined` = 还没跑过）。
   *
   * 与 `setupDone` 分开记账：安装失败不该重试（贵），凭据解析失败必须补偿（便宜）。
   * 认领来的 handle 没有这一步，标 `false` 让首次 ensure 补偿。
   */
  credentialsReady?: boolean
  /** 补偿定时器（同一 handle 只排一个，成功即停） */
  credentialRetryTimer?: ReturnType<typeof setTimeout>
  /** 本地凭据清单缓存（执行前检查只读它；初始化 / 同步后更新，缺失时从磁盘读一次） */
  credentials?: CredentialManifest
}

/** 凭据补偿的重试间隔（解析失败多为 control plane 还没就绪，几秒后自愈） */
const CREDENTIAL_RETRY_INTERVAL_MS = 5_000

/** 执行前检查的结论：拒绝原因 + 这次拒绝是不是**暂态**（值得重试） */
export interface CredentialGateResult {
  denial: CredentialGateDenial
  /** true = 凭据还在落地 / 上次失败正在补偿，稍后重试同一命令有意义 */
  transient: boolean
}

/** 把目录名拼进 `find -name` 的安全判断：只允许普通目录名（不含引号 / 空格 / 路径分隔符） */
/**
 * 执行面：按 `ai_workspaces` 的配置起环境、执行命令、读写文件。
 *
 * - `local`  ：复用 kits 的 L1 沙箱（自托管单租户）；
 * - `container`：docker CLI 起容器（v1 不引 dockerode），exec 进容器执行；
 * - `microvm`：预留，未实现。
 *
 * 运行态只在内存 + 容器标签里，不写 DB（方案 B）。
 */
@Injectable()
export class WorkspaceRuntime {
  private readonly handles = new Map<string, Handle>()
  /**
   * 首次 ensure 的单飞表：同一个 workspace 的并发请求共享同一次创建 / 初始化。
   *
   * 没有它时，并行 bash 工具调用会同时走到「查不到 handle」分支：重复 start、
   * 重复装包，更糟的是后到者可能拿到一个还没 initialize 完的 handle 直接执行。
   */
  private readonly ensuring = new Map<string, Promise<Handle>>()
  private readonly fsImpl: { host: HostFs; container: ContainerFs }
  /** 容器驱动缓存（docker / kubernetes 各一个）；测试注入的驱动放在 docker 槽位兜底 */
  private readonly drivers = new Map<'docker' | 'kubernetes', ContainerDriver>()
  /** 工作区驱动缓存（host / docker / kubernetes）：按工作区解析后复用 */
  private readonly environments = new Map<string, WorkspaceDriver>()
  /**
   * bash 按**工作区**串行、文件写按 **`workspaceId:path`** 串行（`docs/design/workspace.md` §8）。
   *
   * 为什么要串行 bash：命令会写什么由模型决定、无法预判（`npm install`、`git checkout` 都会动共享目录），
   * 只能整个工作区排队；文件写则只锁同一条路径，不同路径互不阻塞。
   * 读不加锁：写已经改了「同目录 tmp + rename」，读端要么读到旧版、要么读到新版，不会是半截。
   */
  private readonly coordinator: WorkspaceCoordinator
  /** 本进程正在跑的命令数（能力网关选路用，不参与正确性） */
  private active = 0
  /** 本进程每个 workspace 的活动命令数（单副本回收器据此跳过在跑命令） */
  private readonly activeWorkspaces = new Map<string, number>()

  constructor(
    @Inject(WorkspaceRepository) private readonly repo: WorkspaceRepository,
    @Inject(SandboxRuntime) private readonly sandbox: SandboxRuntime,
    @Inject(WorkspaceServiceConfig) private readonly config: WorkspaceServiceConfigValue,
    @Inject(WorkspaceSetupService) private readonly setup: WorkspaceSetupService,
    @Inject(AppLogger) private readonly logger: AppLogger,
    /** 只给测试注入用；生产不传，按配置自建（接口类型不能当 token，必须 @Optional） */
    @Optional() driver?: ContainerDriver,
    /** 单副本测试可省略；生产由 Nest 注入（Redis 或本地实现） */
    @Optional() @Inject(WorkspaceCoordinator) coordinator?: WorkspaceCoordinator,
    /** 只给测试注入 fs 实现（默认用 hostFs / containerFs），用于钉串行与边界 */
    @Optional() fsImpl?: { host: HostFs; container: ContainerFs },
  ) {
    this.coordinator = coordinator ?? new WorkspaceCoordinator()
    if (this.config.multiInstance) {
      if (this.config.containerRuntime === 'docker' && !this.config.allowSharedDocker) {
        throw new Error(
          'WORKSPACE_MULTI_INSTANCE=true 的 Docker 后端要求所有副本共享同一个 Docker daemon：' +
            '开发验证请显式设置 WORKSPACE_ALLOW_SHARED_DOCKER=true；跨宿主请用 kubernetes',
        )
      }
      if (!process.env.REDIS_URL) {
        throw new Error('WORKSPACE_MULTI_INSTANCE=true 但未配置 REDIS_URL：跨副本锁依赖 Redis')
      }
    }
    this.fsImpl = fsImpl ?? { host: hostFs, container: containerFs }
    // 驱动按工作区**按需**创建：一套部署里 docker / k8s 可以混跑（见 workspace.containerRuntime）
    if (driver) this.drivers.set('docker', driver)
  }

  /** 这个工作区用哪个容器驱动：driver=pod → kubernetes，其余（container / 空）→ docker */
  private runtimeOf(config: WorkspaceConfig): 'docker' | 'kubernetes' {
    if (config.driver === 'pod') return 'kubernetes'
    if (config.driver === 'container') return 'docker'
    return this.config.containerRuntime
  }

  /** 取（并缓存）某个类型的工作区驱动：工具/初始化只认这一层 */
  private environmentFor(kind: 'host' | 'container' | 'pod'): WorkspaceDriver {
    const cached = this.environments.get(kind)
    if (cached) return cached
    const features = (config: WorkspaceConfig) => this.featuresFor(config)
    const created: WorkspaceDriver =
      kind === 'host'
        ? new HostWorkspaceDriver({ sandbox: this.sandbox, hostFs: this.fsImpl.host, features })
        : new ContainerWorkspaceDriver({
            driver: this.driverFor(kind === 'pod' ? 'kubernetes' : 'docker'),
            fs: this.fsImpl.container,
            features,
            defaultImage: this.config.defaultImage,
            memory: this.config.containerMemory,
            cpus: this.config.containerCpus,
            pidsLimit: this.config.containerPidsLimit,
            network: this.config.containerNetwork,
          })
    this.environments.set(kind, created)
    return created
  }

  /** 按工作区选驱动（坐标解析在执行面，驱动只管原语） */
  private environmentOf(config: WorkspaceConfig): WorkspaceDriver {
    return this.environmentFor(this.resolveEnvironment(config).kind)
  }

  /** 句柄 → 驱动坐标（容器名只有容器驱动认识） */
  private refOf(handle: Handle): DriverRef {
    return {
      workspaceId: handle.workspaceId,
      root: handle.root,
      managed: handle.managed ?? true,
      ...(handle.containerName ? { containerName: handle.containerName } : {}),
    }
  }

  /** 取（并缓存）容器驱动；测试注入的 driver 作为兜底 */
  private driverFor(runtime: 'docker' | 'kubernetes'): ContainerDriver {
    const cached = this.drivers.get(runtime)
    if (cached) return cached
    const created =
      runtime === 'kubernetes'
        ? new KubernetesDriver(this.config.kubectlBin, this.config.k8sNamespace)
        : new DockerDriver({ network: this.config.containerNetwork })
    this.drivers.set(runtime, created)
    return created
  }

  /** 是否启用了跨副本协调（多副本 / 配了 Redis） */
  isDistributed(): boolean {
    return this.coordinator.distributed
  }

  /** 本进程活动命令数（能力网关选路用） */
  activeCount(): number {
    return this.active
  }

  async ensure(workspaceId: string): Promise<WorkspaceStatusResponse> {
    const handle = await this.ensureHandle(workspaceId)
    await this.coordinator.touch(workspaceId)
    return this.toStatus(handle)
  }

  async status(workspaceId: string): Promise<WorkspaceStatusResponse> {
    const handle = this.handles.get(workspaceId)
    if (handle) {
      // 多副本下别的 Pod 可能已经回收了容器；本地 handle 只是缓存，先探活再报 running
      if (
        this.isDistributed() &&
        handle.backend === 'container' &&
        !(await this.containerExists(handle.containerName!, handle.containerRuntime ?? 'docker'))
      ) {
        this.clearCredentialRetry(handle)
        this.handles.delete(workspaceId)
        return { workspaceId, state: 'stopped' }
      }
      return this.toStatus(handle)
    }
    const config = await this.repo.findConfig(workspaceId)
    if (config?.backend === 'container') {
      const running = await this.containerExists(
        this.containerName(workspaceId),
        this.runtimeOf(config),
      )
      return {
        workspaceId,
        state: running ? 'running' : 'stopped',
        ...(running ? { containerId: this.containerName(workspaceId) } : {}),
      }
    }
    return { workspaceId, state: 'stopped' }
  }

  async stop(workspaceId: string): Promise<WorkspaceStatusResponse> {
    return this.coordinator.withLock('lifecycle', workspaceId, async () => {
      const status = await this.stopUnlocked(workspaceId)
      await this.coordinator.clear(workspaceId)
      return status
    })
  }

  async destroy(workspaceId: string): Promise<{ removed: boolean }> {
    await this.stop(workspaceId)
    return { removed: true }
  }

  /** 已持有 lifecycle 锁时调用；不要在锁外直接调，否则回收 / 停止可能和 ensure 竞态 */
  private async stopUnlocked(workspaceId: string): Promise<WorkspaceStatusResponse> {
    const handle = this.handles.get(workspaceId)
    if (handle) this.clearCredentialRetry(handle)
    if (handle) {
      const config = await this.requireConfig(workspaceId)
      await this.environmentOf(config).dispose(this.refOf(handle), 'stop')
    } else {
      // 多副本 / 别的副本回收：没有本地 handle，按配置重建坐标再释放
      const config = await this.repo.findConfig(workspaceId).catch(() => null)
      if (!config || config.backend !== 'container') {
        this.handles.delete(workspaceId)
        return { workspaceId, state: 'stopped' }
      }
      const runtime = this.runtimeOf(config)
      if (this.isDistributed() || runtime === 'kubernetes') {
        await this.environmentOf(config).dispose(
          {
            workspaceId,
            root: CONTAINER_WORKDIR,
            managed: true,
            containerName: this.containerName(workspaceId),
          },
          'stop',
        )
      }
    }
    this.handles.delete(workspaceId)
    return { workspaceId, state: 'stopped' }
  }

  /**
   * 认领孤儿容器：把「DB 里是 container 后端、实际在跑、但内存里没有 handle」的容器登记回来。
   *
   * 为什么必须有：进程重启（发版 / 被调度走）之后 `handles` 是空的，容器却还在跑。
   * 不认领的话 `reapIdle` 永远扫不到它们，会一直占着内存和 CPU 到下一次有人用它为止。
   *
   * `lastUsedAt` 取「现在」而不是容器的启动时间：多活一个 idle 窗口是可接受的，
   * 把一个正在跑命令的容器当成闲置的杀掉不可以。
   */
  async reconcile(now = Date.now()): Promise<number> {
    const rows = await this.repo.listContainerWorkspaceIds()
    let adopted = 0
    for (const row of rows) {
      const { id } = row
      if (this.handles.has(id)) continue
      const name = this.containerName(id)
      const info = await this.driverFor(row.runtime)
        .inspect(name)
        .catch((): { running: boolean; startedAt?: number } => ({ running: false }))
      if (!info.running) continue
      this.handles.set(id, {
        workspaceId: id,
        backend: 'container',
        root: CONTAINER_WORKDIR,
        containerRuntime: row.runtime,
        containerName: name,
        startedAt: info.startedAt ?? now,
        lastUsedAt: now,
        // 认领的容器没跑过本进程的初始化：标 false，首次 ensure 时补一次凭据段
        credentialsReady: false,
      })
      adopted += 1
      this.logger.info('workspace.container.adopted', {
        workspaceId: id,
        containerId: name,
        startedAt: info.startedAt,
      })
    }
    return adopted
  }

  /**
   * 回收器：超过 idleTimeout 的容器停止；`idleTimeoutMs <= 0` 表示常驻不回收。
   *
   * - 单副本：沿用 handle 的 lastUsedAt，但在跑命令的 workspace 跳过；
   * - 多副本：lastUsedAt 从 Redis 读；先抢 lifecycle、再抢 exec，两把都拿到才回收 ——
   *   回收动作由锁串行，别的副本正在跑命令时 exec 锁拿不到，直接跳过。
   */
  async reapIdle(now = Date.now()): Promise<number> {
    if (this.config.idleTimeoutMs <= 0) return 0
    if (!this.coordinator.distributed) {
      // 先认领再回收：否则重启后已在跑的容器永远扫不到，也永远不回收
      await this.reconcile(now).catch((error: unknown) => {
        this.logger.warn('workspace.reconcile.failed', {
          reason: error instanceof Error ? error.message : String(error),
        })
      })
      let reaped = 0
      for (const [id, handle] of this.handles) {
        if ((this.activeWorkspaces.get(id) ?? 0) > 0) continue
        if (now - handle.lastUsedAt < this.config.idleTimeoutMs) continue
        this.logger.info('workspace.reap', { workspaceId: id, idleMs: now - handle.lastUsedAt })
        await this.stop(id).catch(() => undefined)
        reaped += 1
      }
      return reaped
    }

    const rows = await this.repo.listContainerWorkspaceIds().catch((error: unknown) => {
      this.logger.warn('workspace.reap.list_failed', {
        reason: error instanceof Error ? error.message : String(error),
      })
      return [] as { id: string; runtime: 'docker' | 'kubernetes' }[]
    })
    let reaped = 0
    for (const { id, runtime } of rows) {
      const outcome = await this.coordinator.tryWithLock('lifecycle', id, async () => {
        const exec = await this.coordinator.tryWithLock('exec', id, async () => {
          // 列表来自 DB，容器未必在跑；不在跑就没有"回收"可言
          if (!(await this.containerExists(this.containerName(id), runtime))) return false
          const lastUsed = await this.coordinator.lastUsed(id)
          // 没有共享时间 = 不知道有没有人在用；宁可多等一轮，也不误杀
          if (lastUsed === null || now - lastUsed < this.config.idleTimeoutMs) return false
          this.logger.info('workspace.reap', { workspaceId: id, idleMs: now - lastUsed })
          await this.stopUnlocked(id)
          await this.coordinator.clear(id)
          return true
        })
        return exec.acquired && exec.result === true
      })
      if (outcome.acquired && outcome.result) reaped += 1
    }
    return reaped
  }

  async exec(workspaceId: string, request: WorkspaceExecRequest): Promise<WorkspaceExecResult> {
    const handle = await this.ensureLiveHandle(workspaceId)
    handle.lastUsedAt = Date.now()
    await this.coordinator.touch(workspaceId)
    const config = await this.requireConfig(workspaceId)
    // 初始化阶段落地的凭据环境变量随每条命令注入（请求自带的 env 优先）
    const env =
      handle.env && Object.keys(handle.env).length > 0
        ? { ...handle.env, ...request.env }
        : request.env
    // 先计数再等锁：排队中的命令也算“活动”，单副本回收器不能把等待中的工作区当空闲
    this.active += 1
    this.activeWorkspaces.set(workspaceId, (this.activeWorkspaces.get(workspaceId) ?? 0) + 1)
    try {
      return await this.coordinator.withLock('exec', workspaceId, async () => {
        await this.coordinator.touch(workspaceId)
        return this.dispatch(handle, config, { ...request, ...(env ? { env } : {}) })
      })
    } finally {
      this.active -= 1
      const left = (this.activeWorkspaces.get(workspaceId) ?? 1) - 1
      if (left <= 0) this.activeWorkspaces.delete(workspaceId)
      else this.activeWorkspaces.set(workspaceId, left)
      await this.coordinator.touch(workspaceId).catch(() => undefined)
    }
  }

  /** 真正的执行（初始化阶段也复用它，避免 ensureHandle → setup → exec 的递归） */
  private dispatch(
    handle: Handle,
    config: WorkspaceConfig,
    request: WorkspaceExecRequest,
  ): Promise<WorkspaceExecResult> {
    return this.environmentOf(config).exec(this.refOf(handle), config, request)
  }

  /**
   * 凭据同步：把 main 推送的变更重新落地进**已在运行**的工作区（§6.4.6）。
   *
   * **只查不起**：容器不在跑就明确失败（抛错），绝不 ensure —— 否则每次凭据变更
   * 都会把所有闲置工作区唤醒一遍。
   */
  async syncCredentials(
    workspaceId: string,
    expectedVersion?: string,
    options: { skills?: boolean } = {},
  ): Promise<{
    workspaceId: string
    ok: boolean
    credentialVersion: string
    removedSkills?: string[]
  }> {
    const config = await this.requireConfig(workspaceId)
    const handle = await this.adoptRunningHandle(workspaceId, config)
    const shell = this.shellFor(handle, config)
    const features = handle.features ?? this.featuresFor(config)
    const removedSkills = options.skills
      ? (await this.setup.syncSkills(workspaceId, shell)).removed
      : []
    const { env, version, manifest, resolved } = await this.setup.syncCredentials(
      workspaceId,
      shell,
      features,
    )
    // 解析失败时**保留上一份好状态**：空清单 / 残缺 env 覆盖缓存，会把"暂态失败"变成永久拒绝
    if (resolved) {
      handle.env = env
      handle.credentials = { items: manifest }
    }
    handle.credentialsReady = resolved
    if (resolved) this.clearCredentialRetry(handle)
    else this.scheduleCredentialRetry(handle)
    if (expectedVersion && expectedVersion !== version) {
      // 推送方与执行面算出的版本不一致：说明两边读到的表不是同一瞬间，落日志即可（下次同步会收敛）
      this.logger.warn('workspace.sync.version_mismatch', {
        workspaceId,
        expectedVersion,
        actualVersion: version,
      })
    }
    return {
      workspaceId,
      ok: true,
      credentialVersion: version,
      ...(removedSkills.length > 0 ? { removedSkills } : {}),
    }
  }

  /**
   * 执行前检查（§6.4.4）：命令命中某 provider，但本地清单里没有可用凭据 → 拒绝。
   *
   * **纯本地**：只读缓存的 `.billy/credentials.json`（没有缓存时读一次磁盘），
   * 不查库、不做 RPC、不比对版本 —— 拒绝策略不引入延迟，也不受控制面可用性影响。
   *
   * 两条反脆弱口径（issue 9 实测踩过）：
   * - **读失败不缓存**：把「读不出来」缓存成空清单，会让一次失败变成永久拒绝（阴性中毒）；
   * - 拒绝前若缓存为空，**再读一次磁盘**：清单是初始化 / 同步写下的，重读往往就自愈了。
   */
  async authorizeCommand(
    workspaceId: string,
    command: string,
  ): Promise<CredentialGateResult | null> {
    const handle = await this.ensureLiveHandle(workspaceId)
    if (!handle.credentials) {
      handle.credentials = (await this.readCredentialManifest(workspaceId)) ?? undefined
    }
    const denial = checkCommandCredentials(command, handle.credentials ?? null)
    if (!denial) return null

    if (!handle.credentials) {
      const reread = await this.readCredentialManifest(workspaceId)
      if (reread) {
        handle.credentials = reread
        const retried = checkCommandCredentials(command, reread)
        if (!retried) return null
      }
    }
    return { denial, transient: handle.credentialsReady === false }
  }

  /** 读一次清单文件（不存在 / 解析失败返回 null，**不缓存**；不阻断命令） */
  private async readCredentialManifest(workspaceId: string): Promise<CredentialManifest | null> {
    try {
      const result = await this.fs(workspaceId, {
        workspaceId,
        op: 'read',
        path: '.billy/credentials.json',
      })
      if (!result.ok) return null
      // fs read 的出参是 `{ path, content, bytes }`：清单结构在 content 文本里
      const content = (result.data as { content?: unknown } | undefined)?.content
      if (typeof content !== 'string' || content.trim().length === 0) return null
      const parsed = JSON.parse(content) as { version?: unknown; items?: unknown }
      return {
        ...(typeof parsed.version === 'string' ? { version: parsed.version } : {}),
        items: Array.isArray(parsed.items) ? (parsed.items as CredentialManifest['items']) : [],
      }
    } catch {
      // 文件还没写 / JSON 半截：交给调用方"下次再读"，不要缓存成空清单
      return null
    }
  }

  async fs(workspaceId: string, request: WorkspaceFsRequest): Promise<WorkspaceFsResult> {
    const handle = await this.ensureLiveHandle(workspaceId)
    handle.lastUsedAt = Date.now()
    await this.coordinator.touch(workspaceId)
    const run = async (): Promise<WorkspaceFsResult> => {
      const config = await this.requireConfig(workspaceId)
      return this.environmentOf(config).fs(this.refOf(handle), request)
    }
    if (!MUTATING_FS_OPS.has(request.op)) return run()
    // 同一路径的写 / 替换 / 追加 / 删除排队；不同路径、只读操作并行
    return this.coordinator.withLock('fs', `${workspaceId}:${posix.normalize(request.path)}`, run)
  }

  private containerName(workspaceId: string): string {
    return `billy-ws-${workspaceId.toLowerCase()}`
  }

  // ── ensure / 容器管理 ───────────────────────────────────────

  private async ensureHandle(workspaceId: string): Promise<Handle> {
    const existing = this.handles.get(workspaceId)
    if (existing) {
      existing.lastUsedAt = Date.now()
      // 凭据段上次失败（典型：重启窗口里 main 还没就绪）：命中旧 handle 也要补一次，
      // 只重跑凭据段（便宜），不重跑安装（贵）
      if (existing.credentialsReady === false) await this.retryCredentials(existing)
      return existing
    }
    const pending = this.ensuring.get(workspaceId)
    if (pending) return pending
    // 跨副本也要单飞：同一 workspace 只允许一个副本做初始化 / 启容器
    const task = this.coordinator.withLock('lifecycle', workspaceId, () =>
      this.createOrAdoptHandle(workspaceId),
    )
    this.ensuring.set(workspaceId, task)
    try {
      return await task
    } finally {
      this.ensuring.delete(workspaceId)
    }
  }

  /**
   * 取 handle 前确认容器还活着。
   *
   * 多副本下别的 Pod 的回收器可能已经删了这个容器，本地 handles 只是缓存；
   * 直接拿缓存去 exec 会得到一次莫名其妙的「容器不存在」。先探测、失效就重建。
   */
  private async ensureLiveHandle(workspaceId: string): Promise<Handle> {
    let handle = await this.ensureHandle(workspaceId)
    if (this.isDistributed() && handle.backend === 'container') {
      if (
        !(await this.containerExists(handle.containerName!, handle.containerRuntime ?? 'docker'))
      ) {
        this.clearCredentialRetry(handle)
        this.handles.delete(workspaceId)
        handle = await this.ensureHandle(workspaceId)
      }
    }
    return handle
  }

  /**
   * 真正创建 / 认领 handle 的慢路径：由 {@link ensureHandle} 的单飞表保证同一 workspace
   * 同一时刻只有一条在执行。
   */
  private async createOrAdoptHandle(workspaceId: string): Promise<Handle> {
    // 排队等单飞的请求可能在前一条完成后已经有了 handle，这里再查一次
    const existing = this.handles.get(workspaceId)
    if (existing) {
      existing.lastUsedAt = Date.now()
      if (existing.credentialsReady === false) await this.retryCredentials(existing)
      return existing
    }
    const config = await this.requireConfig(workspaceId)
    if (config.backend === 'container') {
      const name = this.containerName(workspaceId)
      const runtime = this.runtimeOf(config)
      const features = this.featuresFor(config)
      const ref: DriverRef = {
        workspaceId,
        root: CONTAINER_WORKDIR,
        managed: true,
        containerName: name,
      }
      // 起环境（镜像比对 + 启动）交给驱动；`started` 决定要不要跑完整初始化
      const { started } = await this.environmentOf(config).prepare(ref, config)
      const handle: Handle = {
        workspaceId,
        backend: 'container',
        root: CONTAINER_WORKDIR,
        containerRuntime: runtime,
        features,
        containerName: name,
        startedAt: Date.now(),
        lastUsedAt: Date.now(),
        // 不是本进程刚建出来的容器：初始化已经由创建它的进程跑过，这里只补便宜的凭据段
        ...(started ? {} : { credentialsReady: false }),
      }
      this.logger.info('workspace.env.features', { workspaceId, ...features })
      if (started) await this.initialize(handle, config)
      else await this.retryCredentials(handle)
      // 初始化完成后再入 Map：否则后到者会看到一个「看起来可用、实际没准备好」的 handle
      this.handles.set(workspaceId, handle)
      return handle
    }
    if (config.backend === 'microvm') {
      throw new Error('microvm 后端未实现')
    }
    if (this.config.multiInstance) {
      throw new Error('WORKSPACE_MULTI_INSTANCE=true 不支持 local 后端：工作区目录在 Pod 本地盘')
    }
    // 目录解析与校验在执行面（允许根 / 凭据目录 / 沙箱可用），驱动只负责建目录
    const plan = await this.localRootPlan(config)
    const features = this.featuresFor(config)
    const ref: DriverRef = { workspaceId, root: plan.root, managed: plan.managed }
    const prepared = await this.environmentOf(config).prepare(ref, config)
    const handle: Handle = {
      workspaceId,
      backend: 'local',
      root: prepared.ref.root,
      managed: plan.managed,
      features,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
    }
    this.logger.info('workspace.env.features', { workspaceId, ...features })
    // 两种 Host 形态都跑初始化，但「跑什么」由声明决定：
    // 技能照物化（正文只从工作区读），装包与凭据按 features 跳过
    await this.initialize(handle, config)
    this.handles.set(workspaceId, handle)
    return handle
  }

  /**
   * 部署级信息：平台、沙箱能力、容器运行时与本地目录配置（`GET /info`）。
   *
   * 只做只读汇总：沙箱探测有进程内缓存，拿不到（测试替身 / 探测异常）就如实标 unknown。
   */
  async info(): Promise<Record<string, unknown>> {
    let sandbox: unknown = { mode: this.sandbox.mode ?? 'unknown', available: 'unknown' }
    try {
      sandbox = await this.sandbox.status()
    } catch {
      // 探测失败不影响 info：这里只是排障信息
    }
    return {
      platform: describePlatform(),
      sandbox,
      containerRuntime: this.config.containerRuntime,
      localRoot: this.config.localRoot,
      localAllowedRoots: this.config.localAllowedRoots ?? [],
      multiInstance: this.config.multiInstance,
    }
  }

  /**
   * 查询执行环境声明（不探测、不建环境）：提示词与后台展示用。
   *
   * 与 `status` 不同，这里**只读配置**：没跑过的工作区也能回答，避免为了渲染提示词去拉起容器。
   */
  async environment(workspaceId: string): Promise<WorkspaceEnvironment> {
    const config = await this.requireConfig(workspaceId)
    if (config.backend === 'container') {
      return {
        workspaceId,
        backend: 'container',
        root: CONTAINER_WORKDIR,
        managed: true,
        driver: this.resolveEnvironment(config).kind,
        fileAccess: config.fileAccess,
        features: this.featuresFor(config),
      }
    }
    const requested = (config.location as { root?: string } | undefined)?.root?.trim()
    return {
      workspaceId,
      backend: config.backend,
      root: requested ? requested : resolve(this.config.localRoot, workspaceId),
      managed: !requested,
      driver: this.resolveEnvironment(config).kind,
      fileAccess: config.fileAccess,
      features: this.featuresFor(config),
    }
  }

  /** 执行环境声明：只看配置与平台，不探测、不建环境（建会话时就能算出来） */
  private featuresFor(config: WorkspaceConfig): WorkspaceFeatures {
    return this.resolveEnvironment(config).features
  }

  /** 按工作区解析环境（kind + 声明）：同一部署内以后可以混跑 host / docker / k8s */
  private resolveEnvironment(config: WorkspaceConfig) {
    return resolveEnvironmentOf({
      backend: config.backend,
      ...(config.driver ? { driver: config.driver } : {}),
      containerRuntime: this.config.containerRuntime,
      containerNetwork: this.config.containerNetwork,
      sandboxEnabled: this.sandbox.sandboxEnabled,
      allowSharedDocker: this.config.allowSharedDocker,
      multiInstance: this.config.multiInstance,
    })
  }

  /**
   * local 后端的根目录计划（平台托管 / 宿主目录）。
   *
   * 宿主目录额外要求沙箱 `enforce`：local 后端的文件能力直接以服务进程身份读写文件，
   * 命令只靠 L1 沙箱划边界；关掉沙箱（`AGENT_WORKSPACE_SANDBOX=false`）等于把用户自己的目录交给
   * 一条没有任何边界的进程，所以 fail closed。
   */
  private async localRootPlan(config: WorkspaceConfig): Promise<LocalRootPlan> {
    const plan = await resolveLocalRoot({
      localRoot: this.config.localRoot,
      workspaceId: config.id,
      requested: (config.location as { root?: string } | undefined)?.root ?? null,
      allowedRoots: this.config.localAllowedRoots ?? [],
    })
    if (!plan.managed && this.sandbox.mode !== 'enforce') {
      throw new HostRootError(
        'unsandboxed',
        '配了目录的工作区要求开启沙箱（AGENT_WORKSPACE_SANDBOX=true）：否则命令直接跑在宿主上、没有隔离边界',
      )
    }
    return plan
  }

  /**
   * 初始化阶段（§6.3）：装 CLI → 物化技能 → 落地凭据 → 写版本。
   *
   * 失败**不阻断执行**：工作区仍可用，问题体现在 `setup_report` 与日志里；
   * 同一个 handle 只跑一次（`setupDone`），避免每条命令都等一遍安装超时。
   *
   * **分段语义**（issue 9）：
   * - 安装失败 → 不重试（重装很贵，且模型看到 retryable=false 会自己换路）；
   * - 凭据段失败 → 标记 `credentialsReady=false` 并排一次补偿定时器。
   *   不能只靠"下一条命令触发 ensure"补偿：模型被拒一次常直接下结论，等不到下一条命令。
   */
  private async initialize(handle: Handle, config: WorkspaceConfig): Promise<void> {
    if (handle.setupDone) return
    handle.setupDone = true
    const shell = this.shellFor(handle, config)
    try {
      const features = handle.features ?? this.featuresFor(config)
      const { env, report, manifest, resolved } = await this.setup.run(
        handle.workspaceId,
        shell,
        features,
      )
      if (resolved) {
        handle.env = env
        handle.credentials = { items: manifest }
      }
      handle.credentialsReady = resolved
      this.logger.info('workspace.setup.applied', {
        workspaceId: handle.workspaceId,
        envKeys: Object.keys(env).length,
        failedPackages: report.packages.filter((item) => item.outcome === 'failed').length,
        failedCredentials: report.credentials.filter((item) => item.outcome === 'failed').length,
        credentialsReady: resolved,
      })
      if (!resolved) this.scheduleCredentialRetry(handle)
    } catch (error) {
      handle.credentialsReady = false
      this.logger.warn('workspace.setup.failed', {
        workspaceId: handle.workspaceId,
        reason: error instanceof Error ? error.message : String(error),
      })
      this.scheduleCredentialRetry(handle)
    }
  }

  /**
   * 只重跑**凭据段**（不装包、不重写技能）。
   *
   * 触发点有三个：命中旧 handle 的 ensure、初始化失败后的定时器、定时器自身的重排。
   * 成功后清定时器；仍失败就再等 5 秒 —— 凭据段很便宜，多试几次好过让模型看到永久拒绝。
   */
  private async retryCredentials(handle: Handle): Promise<void> {
    if (handle.features?.writeHome === false) return
    if (handle.credentialsReady !== false) return
    const config = await this.requireConfig(handle.workspaceId).catch(() => null)
    if (!config) return
    const shell = this.shellFor(handle, config)
    try {
      const { env, manifest, resolved } = await this.setup.syncCredentials(
        handle.workspaceId,
        shell,
        handle.features ?? this.featuresFor(config),
      )
      if (resolved) {
        handle.env = env
        handle.credentials = { items: manifest }
      }
      handle.credentialsReady = resolved
      if (resolved) {
        this.clearCredentialRetry(handle)
        this.logger.info('workspace.credentials.recovered', { workspaceId: handle.workspaceId })
        return
      }
      this.scheduleCredentialRetry(handle)
    } catch (error) {
      handle.credentialsReady = false
      this.logger.warn('workspace.credentials.retry_failed', {
        workspaceId: handle.workspaceId,
        reason: error instanceof Error ? error.message : String(error),
      })
      this.scheduleCredentialRetry(handle)
    }
  }

  /** 排一次凭据补偿（同一 handle 只排一个；handle 被替换或已就绪就放弃） */
  private scheduleCredentialRetry(handle: Handle): void {
    if (handle.credentialRetryTimer) return
    const timer = setTimeout(() => {
      handle.credentialRetryTimer = undefined
      // 初始化期间 handle 还没入 Map（要等 initialize 完成）：此时允许补偿；
      // 只有被另一个 handle 替换掉才放弃。
      const current = this.handles.get(handle.workspaceId)
      if (current && current !== handle) return
      if (handle.credentialsReady !== false) return
      void this.retryCredentials(handle)
    }, CREDENTIAL_RETRY_INTERVAL_MS)
    // 定时器不该吊住进程退出（测试 / 一次性脚本里尤其明显）
    timer.unref?.()
    handle.credentialRetryTimer = timer
  }

  private clearCredentialRetry(handle: Handle): void {
    if (!handle.credentialRetryTimer) return
    clearTimeout(handle.credentialRetryTimer)
    handle.credentialRetryTimer = undefined
  }

  /** 初始化 / 同步用的 shell 端口：命令走 `dispatch`，避免递归回 `exec` */
  private shellFor(handle: Handle, config: WorkspaceConfig) {
    const exec = async (command: string, opts?: { timeoutMs?: number }) => {
      const result = await this.dispatch(handle, config, {
        workspaceId: handle.workspaceId,
        command,
        ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      })
      return {
        ok: result.ok,
        code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      }
    }
    // Host：文件用 Node fs 直写（不依赖 mkdir -p / base64 / chmod，Windows 也能物化技能）；
    // 容器：仍走容器内 shell
    return handle.backend === 'local' ? createHostShell(handle.root, exec) : createExecShell(exec)
  }

  /**
   * 拿一个"已在运行"的句柄（不 start）。
   *
   * 内存里没有句柄时按容器存在性认领 —— 与孤儿回收同口径：**不依赖内存句柄**。
   */
  private async adoptRunningHandle(workspaceId: string, config: WorkspaceConfig): Promise<Handle> {
    const existing = this.handles.get(workspaceId)
    if (existing) return existing

    if (config.backend === 'container') {
      const name = this.containerName(workspaceId)
      const runtime = this.runtimeOf(config)
      if (!(await this.containerExists(name, runtime))) {
        throw new Error('工作区没有在运行，跳过同步')
      }
      const features = this.featuresFor(config)
      const handle: Handle = {
        workspaceId,
        backend: 'container',
        root: CONTAINER_WORKDIR,
        containerRuntime: runtime,
        features,
        containerName: name,
        startedAt: Date.now(),
        lastUsedAt: Date.now(),
        // 这里同样"没跑过初始化"：标 false 让首次 ensure 补凭据（undefined ≠ false）
        credentialsReady: false,
      }
      this.handles.set(workspaceId, handle)
      return handle
    }

    const plan = await this.localRootPlan(config)
    if (plan.managed) await mkdir(plan.root, { recursive: true })
    const handle: Handle = {
      workspaceId,
      backend: 'local',
      root: plan.root,
      managed: plan.managed,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
      credentialsReady: false,
    }
    this.handles.set(workspaceId, handle)
    return handle
  }

  private async requireConfig(workspaceId: string): Promise<WorkspaceConfig> {
    const config = await this.repo.findConfig(workspaceId)
    if (!config) throw new Error(`工作区不存在：${workspaceId}`)
    return config
  }

  private async containerExists(name: string, runtime: 'docker' | 'kubernetes'): Promise<boolean> {
    return this.driverFor(runtime).exists(name)
  }

  private async startContainer(name: string, config: WorkspaceConfig): Promise<void> {
    const image = config.image?.trim() || this.config.defaultImage
    const driver = this.driverFor(this.runtimeOf(config))
    await driver.start({
      name,
      workspaceId: config.id,
      image,
      memory: this.config.containerMemory,
      cpus: this.config.containerCpus,
      pidsLimit: this.config.containerPidsLimit,
      network: this.config.containerNetwork,
    })
    this.logger.info('workspace.container.started', {
      workspaceId: config.id,
      image,
      driver: driver.kind,
    })
  }

  private async removeContainer(name: string, runtime: 'docker' | 'kubernetes'): Promise<void> {
    await this.driverFor(runtime).remove(name)
  }

  private toStatus(handle: Handle): WorkspaceStatusResponse {
    return {
      workspaceId: handle.workspaceId,
      state: 'running' as WorkspaceRuntimeState,
      ...(handle.containerName ? { containerId: handle.containerName } : {}),
      startedAt: handle.startedAt,
      lastUsedAt: handle.lastUsedAt,
    }
  }
}
