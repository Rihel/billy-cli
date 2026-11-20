import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
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
import { DockerDriver, KubernetesDriver, type ContainerDriver } from './container-driver.js'
import { WorkspaceServiceConfig, type WorkspaceServiceConfigValue } from '../config/app-config.js'

/** 容器内固定的工作目录（与镜像约定一致） */
const CONTAINER_WORKDIR = '/workspace'
const MAX_OUTPUT = 64 * 1024

interface Handle {
  workspaceId: string
  backend: WorkspaceConfig['backend']
  root: string
  containerName?: string
  startedAt: number
  lastUsedAt: number
}

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

  constructor(
    @Inject(WorkspaceRepository) private readonly repo: WorkspaceRepository,
    @Inject(SandboxRuntime) private readonly sandbox: SandboxRuntime,
    @Inject(WorkspaceServiceConfig) private readonly config: WorkspaceServiceConfigValue,
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
    const cwd = request.cwd ?? '.'
    const timeoutMs = request.timeoutMs ?? 300_000
    if (handle.backend === 'local') {
      const result = await this.sandbox.exec({
        command: request.command,
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

  async fs(workspaceId: string, request: WorkspaceFsRequest): Promise<WorkspaceFsResult> {
    const handle = await this.ensureHandle(workspaceId)
    handle.lastUsedAt = Date.now()
    if (handle.backend === 'local') return this.localFs(handle.root, request)
    return this.containerFs(handle.containerName!, request)
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
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, body)
          return { ok: true, data: { path: request.path, bytes: body.length } }
        }
        case 'write':
        case 'replace':
        case 'append': {
          await mkdir(dirname(target), { recursive: true })
          const content = request.content ?? ''
          if (request.op === 'append') await appendFile(target, content, 'utf8')
          else await writeFile(target, content, 'utf8')
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
        case 'read': {
          const out = await exec(`cat ${quote(target)}`)
          return { ok: true, data: { path: request.path, content: out.stdout } }
        }
        case 'read-bytes': {
          const out = await exec(`base64 -w0 ${quote(target)}`)
          return { ok: true, data: { base64: out.stdout.trim() } }
        }
        case 'write-bytes': {
          const out = await exec(
            `mkdir -p "$(dirname ${quote(target)})" && base64 -d > ${quote(target)}`,
            request.base64 ?? '',
          )
          if (out.code !== 0) return { ok: false, reason: 'exec-failed', message: out.stderr }
          return { ok: true, data: { path: request.path } }
        }
        case 'write':
        case 'append':
        case 'replace': {
          const redirect = request.op === 'append' ? '>>' : '>'
          const out = await exec(
            `mkdir -p "$(dirname ${quote(target)})" && cat ${redirect} ${quote(target)}`,
            request.content ?? '',
          )
          if (out.code !== 0) {
            return { ok: false, reason: 'exec-failed', message: out.stderr }
          }
          return {
            ok: true,
            data: { path: request.path, bytes: Buffer.byteLength(request.content ?? '') },
          }
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
      return existing
    }
    const config = await this.requireConfig(workspaceId)
    if (config.backend === 'container') {
      const name = this.containerName(workspaceId)
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
