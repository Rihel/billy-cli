import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { WorkspaceRuntimeService as SandboxRuntime } from '@repo/kits'
import type {
  WorkspaceConfig,
  WorkspaceExecRequest,
  WorkspaceExecResult,
  WorkspaceFsRequest,
  WorkspaceFsResult,
} from '@repo/contracts'
import type { HostFs } from '../fs/host-fs.js'
import { withEnvPrefixFor } from '../exec/env.js'
import type { DisposeMode, DriverRef, FeaturesResolver, WorkspaceDriver } from './types.js'

/** 单条命令输出上限（字节）：再大就截断，不塞进内存 */
const MAX_OUTPUT = 64 * 1024
/** 执行超时默认值：与工具声明对齐 */
const DEFAULT_TIMEOUT = 300_000

export interface HostDriverOptions {
  sandbox: SandboxRuntime
  hostFs: HostFs
  features: FeaturesResolver
  maxOutput?: number
}

/**
 * **宿主驱动**：命令在宿主机上跑（经沙箱包装），文件直接用 Node fs。
 *
 * 目录的解析与校验不在这里：调用方（执行面）已经算好 `ref.root` 并校验过
 * 「在允许根内 / 不覆盖凭据目录 / 沙箱可用」；这里只负责建目录、执行、读写、释放。
 */
export class HostWorkspaceDriver implements WorkspaceDriver {
  readonly kind = 'host' as const

  constructor(private readonly options: HostDriverOptions) {}

  async probe(): Promise<{ available: boolean; reason?: string }> {
    try {
      const status = await this.options.sandbox.status()
      return {
        available: status.sandbox.available,
        ...(status.sandbox.reason?.message ? { reason: status.sandbox.reason.message } : {}),
      }
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async prepare(ref: DriverRef): Promise<{ ref: DriverRef; started: boolean }> {
    // 托管目录不存在就建；用户指定目录必须已存在（由执行面校验过）
    if (ref.managed) await mkdir(ref.root, { recursive: true })
    return { ref, started: true }
  }

  async exec(
    ref: DriverRef,
    config: WorkspaceConfig,
    request: WorkspaceExecRequest,
  ): Promise<WorkspaceExecResult> {
    const features = this.options.features(config)
    const result = await this.options.sandbox.exec({
      // 沙箱的 exec 没有 env 端口：按当前 shell 生成注入前缀（sh / cmd）
      command: withEnvPrefixFor(features.shell, request.command, request.env),
      cwd: resolve(ref.root, request.cwd ?? '.'),
      workspaceRoot: ref.root,
      fileAccess: config.fileAccess === 'read-only' ? 'read-only' : 'workspace-write',
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT,
      maxOutputBytes: request.maxOutputBytes ?? this.options.maxOutput ?? MAX_OUTPUT,
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

  fs(ref: DriverRef, request: WorkspaceFsRequest): Promise<WorkspaceFsResult> {
    return this.options.hostFs(ref.root, request)
  }

  async dispose(ref: DriverRef, mode: DisposeMode): Promise<void> {
    // Host：stop = 什么都不做（目录留给人）；purge 才删目录
    if (mode === 'purge') await rm(ref.root, { recursive: true, force: true })
  }
}
