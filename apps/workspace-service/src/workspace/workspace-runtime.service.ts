import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, posix, relative, resolve, isAbsolute } from 'node:path'
import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, WorkspaceRuntimeService as SandboxRuntime } from '@repo/kits'
import type {
  WorkspaceConfig,
  WorkspaceExecRequest,
  WorkspaceExecResult,
  WorkspaceFsRequest,
  WorkspaceFsResult,
  WorkspaceRuntimeState,
  WorkspaceStatusResponse,
} from '@repo/contracts'
import { WorkspaceRepository } from './workspace.repository.js'
import { WorkspaceSetupService } from './workspace-setup.service.js'
import { createExecShell } from './setup-shell.js'
import { KeyedMutex } from './keyed-mutex.js'
import {
  checkCommandCredentials,
  type CredentialGateDenial,
  type CredentialManifest,
} from './credential-gate.js'
import { DockerDriver, KubernetesDriver, type ContainerDriver } from './container-driver.js'
import { withEnvPrefix } from './exec-env.js'
import { WorkspaceServiceConfig, type WorkspaceServiceConfigValue } from '../config/app-config.js'

/** 容器内固定的工作目录（与镜像约定一致） */
const CONTAINER_WORKDIR = '/workspace'
const MAX_OUTPUT = 64 * 1024

/** 会改动工作区文件的操作：只有它们需要按路径串行（读不排队，靠原子写保证读到的不是半截） */
const MUTATING_FS_OPS = new Set(['write', 'write-bytes', 'append', 'replace', 'remove'])

/** 原子写的临时文件后缀（同目录内 `rename` 才是原子的，不跨目录） */
const tmpSuffix = (): string => `.billy-tmp-${randomBytes(4).toString('hex')}`

interface Handle {
  workspaceId: string
  backend: WorkspaceConfig['backend']
  root: string
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
const isSafeDirName = (name: string): boolean => /^[A-Za-z0-9._-]+$/.test(name)

/**
 * 一次 `find` 取回整棵树（容器后端）。
 *
 * `-printf '%P\t%s\t%T@\n'`：相对路径、字节数、mtime（秒.毫秒），
 * 避免每个文件一次 `docker exec`（实测 1500 个文件要 58 秒）。
 */
export const buildFindTreeCommand = (
  target: string,
  maxDepth: number,
  excludeDirs: readonly string[],
): string => {
  const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`
  const names = excludeDirs.filter(isSafeDirName)
  // 不用 `\( … \)` 分组：容器里是 dash（sh），反斜杠在字符串里还要再转义一层，极易写错；
  // `-not -path '*/NAME/*'` 没有括号、无需分组，语义也更直白。
  const excludes = names.map((name) => `-not -path ${quote(`*/${name}/*`)}`).join(' ')
  return `find ${quote(target)} -maxdepth ${Math.max(1, Math.floor(maxDepth))} -type f ${excludes} -printf '%P\\t%s\\t%T@\\n'`
}

/** 解析 `find -printf` 的输出（容器与测试共用；坏行直接跳过，不整体失败） */
export const parseFindTree = (stdout: string): { path: string; size: number; mtime: number }[] =>
  stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [rawPath, rawSize, rawMtime] = line.split('\t')
      if (!rawPath || !rawSize) return []
      const size = Number(rawSize)
      const seconds = Number(rawMtime)
      if (!Number.isFinite(size) || !Number.isFinite(seconds)) return []
      return [{ path: rawPath, size, mtime: Math.round(seconds * 1000) }]
    })

const inside = (root: string, target: string): boolean => {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

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
  private readonly driver: ContainerDriver
  /**
   * bash 按**工作区**串行、文件写按 **`workspaceId:path`** 串行（`docs/design/workspace.md` §8）。
   *
   * 为什么要串行 bash：命令会写什么由模型决定、无法预判（`npm install`、`git checkout` 都会动共享目录），
   * 只能整个工作区排队；文件写则只锁同一条路径，不同路径互不阻塞。
   * 读不加锁：写已经改了「同目录 tmp + rename」，读端要么读到旧版、要么读到新版，不会是半截。
   */
  private readonly execLocks = new KeyedMutex()
  private readonly fsLocks = new KeyedMutex()

  constructor(
    @Inject(WorkspaceRepository) private readonly repo: WorkspaceRepository,
    @Inject(SandboxRuntime) private readonly sandbox: SandboxRuntime,
    @Inject(WorkspaceServiceConfig) private readonly config: WorkspaceServiceConfigValue,
    @Inject(WorkspaceSetupService) private readonly setup: WorkspaceSetupService,
    @Inject(AppLogger) private readonly logger: AppLogger,
    /** 只给测试注入用；生产不传，按配置自建 */
    driver?: ContainerDriver,
  ) {
    this.driver =
      driver ??
      (this.config.containerRuntime === 'kubernetes'
        ? new KubernetesDriver(this.config.kubectlBin, this.config.k8sNamespace)
        : new DockerDriver())
  }

  async ensure(workspaceId: string): Promise<WorkspaceStatusResponse> {
    const handle = await this.ensureHandle(workspaceId)
    return this.toStatus(handle)
  }

  async status(workspaceId: string): Promise<WorkspaceStatusResponse> {
    const handle = this.handles.get(workspaceId)
    if (handle) return this.toStatus(handle)
    const config = await this.repo.findConfig(workspaceId)
    if (config?.backend === 'container') {
      const running = await this.containerExists(this.containerName(workspaceId))
      return {
        workspaceId,
        state: running ? 'running' : 'stopped',
        ...(running ? { containerId: this.containerName(workspaceId) } : {}),
      }
    }
    return { workspaceId, state: 'stopped' }
  }

  async stop(workspaceId: string): Promise<WorkspaceStatusResponse> {
    const handle = this.handles.get(workspaceId)
    if (handle) this.clearCredentialRetry(handle)
    if (handle?.backend === 'container') {
      await this.removeContainer(handle.containerName!)
    }
    this.handles.delete(workspaceId)
    return { workspaceId, state: 'stopped' }
  }

  async destroy(workspaceId: string): Promise<{ removed: boolean }> {
    await this.stop(workspaceId)
    return { removed: true }
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
    const ids = await this.repo.listContainerWorkspaceIds()
    let adopted = 0
    for (const id of ids) {
      if (this.handles.has(id)) continue
      const name = this.containerName(id)
      const info = await this.driver
        .inspect(name)
        .catch((): { running: boolean; startedAt?: number } => ({ running: false }))
      if (!info.running) continue
      this.handles.set(id, {
        workspaceId: id,
        backend: 'container',
        root: CONTAINER_WORKDIR,
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

  /** 回收器：超过 idleTimeout 的 handle 停止容器；`idleTimeoutMs <= 0` 表示常驻不回收 */
  async reapIdle(now = Date.now()): Promise<number> {
    if (this.config.idleTimeoutMs <= 0) return 0
    // 先认领再回收：否则重启后已在跑的容器永远扫不到，也永远不回收
    await this.reconcile(now).catch((error: unknown) => {
      this.logger.warn('workspace.reconcile.failed', {
        reason: error instanceof Error ? error.message : String(error),
      })
    })
    let reaped = 0
    for (const [id, handle] of this.handles) {
      if (now - handle.lastUsedAt < this.config.idleTimeoutMs) continue
      this.logger.info('workspace.reap', { workspaceId: id, idleMs: now - handle.lastUsedAt })
      await this.stop(id).catch(() => undefined)
      reaped += 1
    }
    return reaped
  }

  async exec(workspaceId: string, request: WorkspaceExecRequest): Promise<WorkspaceExecResult> {
    const handle = await this.ensureHandle(workspaceId)
    handle.lastUsedAt = Date.now()
    const config = await this.requireConfig(workspaceId)
    // 初始化阶段落地的凭据环境变量随每条命令注入（请求自带的 env 优先）
    const env =
      handle.env && Object.keys(handle.env).length > 0
        ? { ...handle.env, ...request.env }
        : request.env
    return this.execLocks.run(workspaceId, () =>
      this.dispatch(handle, config, { ...request, ...(env ? { env } : {}) }),
    )
  }

  /** 真正的执行（初始化阶段也复用它，避免 ensureHandle → setup → exec 的递归） */
  private async dispatch(
    handle: Handle,
    config: WorkspaceConfig,
    request: WorkspaceExecRequest,
  ): Promise<WorkspaceExecResult> {
    const cwd = request.cwd ?? '.'
    const timeoutMs = request.timeoutMs ?? 300_000
    if (handle.backend === 'local') {
      const result = await this.sandbox.exec({
        // kits 的 exec 入参没有 env 端口：local 用命令前缀包装，cwd 等字段保持不变
        command: withEnvPrefix(request.command, request.env),
        cwd: resolve(handle.root, cwd),
        workspaceRoot: handle.root,
        fileAccess: config.fileAccess === 'read-only' ? 'read-only' : 'workspace-write',
        timeoutMs,
        maxOutputBytes: request.maxOutputBytes ?? MAX_OUTPUT,
      })
      return {
        ok: result.ok,
        exitCode: result.exitCode ?? -1,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        truncated: result.truncated,
        runtime: 'sandbox',
        ...(result.reason
          ? { reason: result.timedOut ? 'timeout' : 'exec-failed', message: result.reason }
          : {}),
      }
    }
    const outcome = await this.driver.exec(handle.containerName!, {
      command: request.command,
      cwd: resolve(CONTAINER_WORKDIR, cwd),
      timeoutMs,
      ...(request.env ? { env: request.env } : {}),
    })
    return {
      ok: outcome.code === 0,
      exitCode: outcome.code,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      durationMs: outcome.durationMs,
      truncated: outcome.stdout.length >= (request.maxOutputBytes ?? MAX_OUTPUT),
      runtime: 'container',
      ...(outcome.timedOut
        ? { reason: 'timeout', message: `命令超时（${timeoutMs}ms）` }
        : outcome.code === 0
          ? {}
          : { reason: 'exec-failed', message: outcome.stderr.slice(0, 500) }),
    }
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
    const removedSkills = options.skills
      ? (await this.setup.syncSkills(workspaceId, shell)).removed
      : []
    const { env, version, manifest, resolved } = await this.setup.syncCredentials(
      workspaceId,
      shell,
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
    const handle = await this.ensureHandle(workspaceId)
    if (!handle.credentials) {
      handle.credentials = (await this.readCredentialManifest(workspaceId, handle)) ?? undefined
    }
    const denial = checkCommandCredentials(command, handle.credentials ?? null)
    if (!denial) return null

    if (!handle.credentials) {
      const reread = await this.readCredentialManifest(workspaceId, handle)
      if (reread) {
        handle.credentials = reread
        const retried = checkCommandCredentials(command, reread)
        if (!retried) return null
      }
    }
    return { denial, transient: handle.credentialsReady === false }
  }

  /** 读一次清单文件（不存在 / 解析失败返回 null，**不缓存**；不阻断命令） */
  private async readCredentialManifest(
    workspaceId: string,
    handle: Handle,
  ): Promise<CredentialManifest | null> {
    try {
      const result =
        handle.backend === 'local'
          ? await this.localFs(handle.root, {
              workspaceId,
              op: 'read',
              path: '.billy/credentials.json',
            })
          : await this.containerFs(handle.containerName!, {
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
    const handle = await this.ensureHandle(workspaceId)
    handle.lastUsedAt = Date.now()
    const run = (): Promise<WorkspaceFsResult> =>
      handle.backend === 'local'
        ? this.localFs(handle.root, request)
        : this.containerFs(handle.containerName!, request)
    if (!MUTATING_FS_OPS.has(request.op)) return run()
    // 同一路径的写 / 替换 / 追加 / 删除排队；不同路径、只读操作并行
    return this.fsLocks.run(`${workspaceId}:${posix.normalize(request.path)}`, run)
  }

  // ── 后端：local ──────────────────────────────────────────────

  private async localFs(root: string, request: WorkspaceFsRequest): Promise<WorkspaceFsResult> {
    const target = resolve(root, request.path)
    if (!inside(root, target)) {
      return { ok: false, reason: 'unsafe-path', message: '路径必须工作区内' }
    }
    try {
      switch (request.op) {
        case 'list': {
          const entries = await readdir(target, { withFileTypes: true })
          return {
            ok: true,
            data: {
              entries: await Promise.all(
                entries.map(async (entry) => {
                  const full = join(target, entry.name)
                  const info = await stat(full).catch(() => null)
                  return {
                    name: entry.name,
                    path: relative(root, full),
                    type: entry.isDirectory() ? 'dir' : 'file',
                    size: info?.size ?? 0,
                    mtime: info?.mtimeMs ?? 0,
                  }
                }),
              ),
            },
          }
        }
        case 'list-tree': {
          // 本地后端：一次递归读完（每个目录一次 readdir，不再逐文件 stat 往返）
          const excluded = new Set(request.excludeDirs ?? [])
          const maxDepth = request.maxDepth ?? 16
          const entries: { path: string; size: number; mtime: number }[] = []
          const walk = async (dir: string, depth: number): Promise<void> => {
            if (depth > maxDepth) return
            const children = await readdir(dir, { withFileTypes: true }).catch(() => [])
            for (const child of children) {
              if (child.isSymbolicLink()) continue
              const full = join(dir, child.name)
              if (child.isDirectory()) {
                if (excluded.has(child.name)) continue
                await walk(full, depth + 1)
                continue
              }
              if (!child.isFile()) continue
              const info = await stat(full).catch(() => null)
              if (!info) continue
              entries.push({ path: relative(target, full), size: info.size, mtime: info.mtimeMs })
            }
          }
          await walk(target, 0)
          return { ok: true, data: { entries } }
        }
        case 'read': {
          const content = await readFile(target, 'utf8')
          return {
            ok: true,
            data: { path: request.path, content, bytes: Buffer.byteLength(content) },
          }
        }
        case 'read-bytes': {
          const body = await readFile(target)
          return { ok: true, data: { base64: body.toString('base64'), bytes: body.length } }
        }
        case 'write-bytes': {
          const body = Buffer.from(request.base64 ?? '', 'base64')
          await this.writeAtomic(target, body)
          return { ok: true, data: { path: request.path, bytes: body.length } }
        }
        case 'write':
        case 'replace':
        case 'append': {
          const content = request.content ?? ''
          if (request.op === 'append') {
            await mkdir(dirname(target), { recursive: true })
            await appendFile(target, content, 'utf8')
          } else {
            await this.writeAtomic(target, content)
          }
          return { ok: true, data: { path: request.path, bytes: Buffer.byteLength(content) } }
        }
        case 'stat': {
          const info = await stat(target)
          return {
            ok: true,
            data: {
              path: request.path,
              type: info.isDirectory() ? 'dir' : 'file',
              size: info.size,
              mtime: info.mtimeMs,
            },
          }
        }
        case 'remove': {
          await rm(target, { recursive: true, force: true })
          return { ok: true, data: { path: request.path, removed: true } }
        }
        case 'search': {
          const entries = await readdir(target, { withFileTypes: true, recursive: true })
          const needle = request.query ?? ''
          const matches: string[] = []
          for (const entry of entries) {
            if (!entry.isFile()) continue
            const full = join(entry.parentPath ?? target, entry.name)
            const content = await readFile(full, 'utf8').catch(() => '')
            if (content.includes(needle)) matches.push(relative(root, full))
          }
          return { ok: true, data: { matches } }
        }
      }
    } catch (error) {
      return {
        ok: false,
        reason: 'exec-failed',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * 原子写：先写同目录临时文件，再 `rename` 覆盖目标。
   *
   * 为什么不是直接 `writeFile(target)`：直接写会先截断再逐块写，并发的 `read` 可能读到半截
   * （模型读到半份 JSON 会得出"文件坏了"的结论）。`rename` 在同一文件系统上是原子的，
   * 读端只会看到旧版或新版。临时文件必须在**同目录**，跨目录 rename 会退化成拷贝。
   */
  private async writeAtomic(target: string, body: string | Buffer): Promise<void> {
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}${tmpSuffix()}`
    try {
      await writeFile(tmp, body)
      await rename(tmp, target)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  // ── 后端：container ─────────────────────────────────────────

  private containerName(workspaceId: string): string {
    return `billy-ws-${workspaceId.toLowerCase()}`
  }

  private async containerFs(name: string, request: WorkspaceFsRequest): Promise<WorkspaceFsResult> {
    const target = resolve(CONTAINER_WORKDIR, request.path)
    if (!target.startsWith(CONTAINER_WORKDIR)) {
      return { ok: false, reason: 'unsafe-path', message: '路径必须工作区内' }
    }
    const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`
    const exec = (command: string, stdin?: string) =>
      this.driver.exec(name, { command, cwd: CONTAINER_WORKDIR, timeoutMs: 30_000, stdin })
    try {
      switch (request.op) {
        case 'list': {
          const out = await exec(`ls -1p ${quote(target)}`)
          const entries = out.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => (line && !line.endsWith('/') ? true : line.length > 1))
            .filter((line) => line !== './')
            .map((line) => {
              const dir = line.endsWith('/')
              const name = dir ? line.slice(0, -1) : line
              return { name, path: name, type: dir ? 'dir' : 'file' }
            })
          return { ok: true, data: { entries } }
        }
        case 'list-tree': {
          // 容器后端：**一次 find** 拿回全部路径 / 大小 / mtime（根治逐文件 docker exec）
          const out = await exec(
            buildFindTreeCommand(target, request.maxDepth ?? 16, request.excludeDirs ?? []),
          )
          if (out.code !== 0) return { ok: false, reason: 'exec-failed', message: out.stderr }
          return { ok: true, data: { entries: parseFindTree(out.stdout) } }
        }
        case 'read': {
          const out = await exec(`cat ${quote(target)}`)
          // 文件不存在时 `cat` 非 0：不能把空输出当成"读到了空清单"（会把拒绝永久化）
          if (out.code !== 0) return { ok: false, reason: 'exec-failed', message: out.stderr }
          return { ok: true, data: { path: request.path, content: out.stdout } }
        }
        case 'read-bytes': {
          const out = await exec(`base64 -w0 ${quote(target)}`)
          return { ok: true, data: { base64: out.stdout.trim() } }
        }
        case 'write-bytes': {
          const tmp = `${target}${tmpSuffix()}`
          const out = await exec(
            `mkdir -p "$(dirname ${quote(target)})" && base64 -d > ${quote(tmp)} && mv -f ${quote(tmp)} ${quote(target)}`,
            request.base64 ?? '',
          )
          if (out.code !== 0) {
            await exec(`rm -f ${quote(tmp)}`).catch(() => undefined)
            return { ok: false, reason: 'exec-failed', message: out.stderr }
          }
          return { ok: true, data: { path: request.path } }
        }
        case 'write':
        case 'append':
        case 'replace': {
          const content = request.content ?? ''
          // 追加不重建文件；写 / 替换走「同目录 tmp + mv」，容器内 mv 是原子 rename
          if (request.op === 'append') {
            const out = await exec(
              `mkdir -p "$(dirname ${quote(target)})" && cat >> ${quote(target)}`,
              content,
            )
            if (out.code !== 0) {
              return { ok: false, reason: 'exec-failed', message: out.stderr }
            }
            return { ok: true, data: { path: request.path, bytes: Buffer.byteLength(content) } }
          }
          const tmp = `${target}${tmpSuffix()}`
          const out = await exec(
            `mkdir -p "$(dirname ${quote(target)})" && cat > ${quote(tmp)} && mv -f ${quote(tmp)} ${quote(target)}`,
            content,
          )
          if (out.code !== 0) {
            await exec(`rm -f ${quote(tmp)}`).catch(() => undefined)
            return { ok: false, reason: 'exec-failed', message: out.stderr }
          }
          return { ok: true, data: { path: request.path, bytes: Buffer.byteLength(content) } }
        }
        case 'stat': {
          const out = await exec(`stat -c '%F|%s|%Y' ${quote(target)}`)
          const [kind, size, mtime] = out.stdout.trim().split('|')
          return {
            ok: true,
            data: {
              path: request.path,
              type: kind?.includes('directory') ? 'dir' : 'file',
              size: Number(size ?? 0),
              mtime: Number(mtime ?? 0) * 1000,
            },
          }
        }
        case 'remove': {
          await exec(`rm -rf ${quote(target)}`)
          return { ok: true, data: { path: request.path, removed: true } }
        }
        case 'search': {
          const out = await exec(`grep -r -l ${quote(request.query ?? '')} ${quote(target)}`)
          return {
            ok: true,
            data: {
              matches: out.stdout
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean),
            },
          }
        }
      }
    } catch (error) {
      return {
        ok: false,
        reason: 'exec-failed',
        message: error instanceof Error ? error.message : String(error),
      }
    }
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
    const config = await this.requireConfig(workspaceId)
    if (config.backend === 'container') {
      const name = this.containerName(workspaceId)
      if (await this.containerExists(name)) {
        // 镜像升级后，运行中的容器仍是旧镜像（旧源 / 旧工具链）：重建一次才换得过来。
        // 容器里的内容是临时的（tmpfs），重建不丢"资产"，只是要重新装依赖。
        const wanted = config.image?.trim() || this.config.defaultImage
        const actual = await this.driver.imageOf(name).catch(() => null)
        if (actual && actual !== wanted) {
          this.logger.warn('workspace.image.stale', { workspaceId, actual, wanted })
          await this.removeContainer(name)
        }
      }
      if (!(await this.containerExists(name))) await this.startContainer(name, config)
      const handle: Handle = {
        workspaceId,
        backend: 'container',
        root: CONTAINER_WORKDIR,
        containerName: name,
        startedAt: Date.now(),
        lastUsedAt: Date.now(),
      }
      this.handles.set(workspaceId, handle)
      await this.initialize(handle, config)
      return handle
    }
    if (config.backend === 'microvm') {
      throw new Error('microvm 后端未实现')
    }
    const root = resolve(
      this.config.localRoot,
      String((config.location as { root?: string } | undefined)?.root ?? workspaceId),
    )
    await mkdir(root, { recursive: true })
    const handle: Handle = {
      workspaceId,
      backend: 'local',
      root,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
    }
    this.handles.set(workspaceId, handle)
    await this.initialize(handle, config)
    return handle
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
      const { env, report, manifest, resolved } = await this.setup.run(handle.workspaceId, shell)
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
    if (handle.credentialsReady !== false) return
    const config = await this.requireConfig(handle.workspaceId).catch(() => null)
    if (!config) return
    const shell = this.shellFor(handle, config)
    try {
      const { env, manifest, resolved } = await this.setup.syncCredentials(
        handle.workspaceId,
        shell,
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
      if (this.handles.get(handle.workspaceId) !== handle) return
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
    return createExecShell(async (command, opts) => {
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
    })
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
      if (!(await this.containerExists(name))) throw new Error('工作区没有在运行，跳过同步')
      const handle: Handle = {
        workspaceId,
        backend: 'container',
        root: CONTAINER_WORKDIR,
        containerName: name,
        startedAt: Date.now(),
        lastUsedAt: Date.now(),
        // 这里同样"没跑过初始化"：标 false 让首次 ensure 补凭据（undefined ≠ false）
        credentialsReady: false,
      }
      this.handles.set(workspaceId, handle)
      return handle
    }

    const root = resolve(
      this.config.localRoot,
      String((config.location as { root?: string } | undefined)?.root ?? workspaceId),
    )
    const handle: Handle = {
      workspaceId,
      backend: 'local',
      root,
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

  private async containerExists(name: string): Promise<boolean> {
    return this.driver.exists(name)
  }

  private async startContainer(name: string, config: WorkspaceConfig): Promise<void> {
    const image = config.image?.trim() || this.config.defaultImage
    await this.driver.start({
      name,
      workspaceId: config.id,
      image,
      memory: this.config.containerMemory,
      cpus: this.config.containerCpus,
      pidsLimit: this.config.containerPidsLimit,
    })
    this.logger.info('workspace.container.started', {
      workspaceId: config.id,
      image,
      driver: this.driver.kind,
    })
  }

  private async removeContainer(name: string): Promise<void> {
    await this.driver.remove(name)
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
