import { resolve } from 'node:path'
import type {
  WorkspaceConfig,
  WorkspaceExecRequest,
  WorkspaceExecResult,
  WorkspaceFsRequest,
  WorkspaceFsResult,
} from '@repo/contracts'
import type { ContainerDriver } from '../container/driver.js'
import type { ContainerFs } from '../fs/container-fs.js'
import type { DisposeMode, DriverRef, FeaturesResolver, WorkspaceDriver } from './types.js'

/** 容器内固定的工作目录（与镜像约定一致） */
const CONTAINER_WORKDIR = '/workspace'
const MAX_OUTPUT = 64 * 1024
const DEFAULT_TIMEOUT = 300_000

export interface ContainerDriverOptions {
  driver: ContainerDriver
  fs: ContainerFs
  features: FeaturesResolver
  /** 镜像缺省值（工作区没配 image 时） */
  defaultImage: string
  memory: string
  cpus: string
  pidsLimit: number
  network: 'bridge' | 'none'
}

/**
 * **容器驱动**（docker / kubernetes 共用同一套逻辑，差异全在 `ContainerDriver` 实现里）。
 *
 * 起环境时做两件事：镜像不一致就重建（否则跑的是旧工具链）、没在跑就起。
 * 文件能力复用注入的 `containerFs`（把统一 op 翻译成容器命令）。
 */
export class ContainerWorkspaceDriver implements WorkspaceDriver {
  readonly kind: 'docker' | 'kubernetes'

  constructor(private readonly options: ContainerDriverOptions) {
    this.kind = options.driver.kind === 'docker' ? 'docker' : 'kubernetes'
  }

  async probe(): Promise<{ available: boolean; reason?: string }> {
    // 探活靠「看得见已有容器」：拿不到名字说明 daemon / 集群不可达
    try {
      await this.options.driver.inspect('__probe__')
      return { available: true }
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async prepare(
    ref: DriverRef,
    config: WorkspaceConfig,
  ): Promise<{ ref: DriverRef; started: boolean }> {
    const name = ref.containerName
    if (!name) throw new Error('容器驱动缺少容器名')
    const wanted = config.image?.trim() || this.options.defaultImage
    let running = await this.options.driver.exists(name)
    if (running) {
      // 镜像升级后运行中的容器仍是旧镜像：重建一次才换得过来（容器内数据本就是临时的）
      const actual = await this.options.driver.imageOf(name).catch(() => null)
      if (actual && actual !== wanted) {
        await this.options.driver.remove(name)
        running = false
      }
    }
    if (!running) {
      await this.options.driver.start({
        name,
        workspaceId: ref.workspaceId,
        image: wanted,
        memory: this.options.memory,
        cpus: this.options.cpus,
        pidsLimit: this.options.pidsLimit,
        network: this.options.network,
      })
      return { ref, started: true }
    }
    return { ref, started: false }
  }

  async exec(
    ref: DriverRef,
    _config: WorkspaceConfig,
    request: WorkspaceExecRequest,
  ): Promise<WorkspaceExecResult> {
    const outcome = await this.options.driver.exec(ref.containerName!, {
      command: request.command,
      cwd: resolve(CONTAINER_WORKDIR, request.cwd ?? '.'),
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT,
      maxOutputBytes: request.maxOutputBytes ?? MAX_OUTPUT,
      ...(request.env ? { env: request.env } : {}),
    })
    return {
      ok: outcome.code === 0,
      exitCode: outcome.code,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      durationMs: outcome.durationMs,
      // 以驱动实测的截断标记为准（不再拿输出长度猜）
      truncated: outcome.stdoutTruncated || outcome.stderrTruncated,
      runtime: 'container',
      ...(outcome.timedOut
        ? { reason: 'timeout', message: `命令超时（${request.timeoutMs ?? DEFAULT_TIMEOUT}ms）` }
        : outcome.code === 0
          ? {}
          : { reason: 'exec-failed', message: outcome.stderr.slice(0, 500) }),
    }
  }

  fs(ref: DriverRef, request: WorkspaceFsRequest): Promise<WorkspaceFsResult> {
    return this.options.fs(
      (command, stdin) =>
        this.options.driver.exec(ref.containerName!, {
          command,
          cwd: CONTAINER_WORKDIR,
          timeoutMs: 30_000,
          stdin,
        }),
      request,
    )
  }

  async dispose(ref: DriverRef, _mode: DisposeMode): Promise<void> {
    // 容器数据是临时的（Tmpfs / emptyDir）：stop 与 purge 都直接删容器
    await this.options.driver.remove(ref.containerName!)
  }
}
