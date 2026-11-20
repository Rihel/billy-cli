import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, Db } from '@repo/kits'
import { AiWorkspaceEntity } from '@repo/db'
import { credentialVersionOf } from '@repo/shared'
import type { OwnerRef } from '../../../common/security/index.js'
import { PersonalCredentialRepository } from './credential.repository.js'

/** 同步端口：main → workspace-service 的“查状态 / 推同步”（测试可替换） */
export interface WorkspaceSyncPort {
  /** 只查不起：拿实时运行态 */
  status(workspaceId: string): Promise<{ state: string }>
  /** 把凭据重新落地进运行中的工作区 */
  sync(workspaceId: string, version: string): Promise<{ credentialVersion: string }>
}

export const CREDENTIAL_SYNC_PORT = Symbol('CREDENTIAL_SYNC_PORT')

/** 普通变更的重试延迟（5 次）；吊销更激进，因为旧凭据仍可用 */
const RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 30_000, 60_000]
const MAX_ATTEMPTS_DEFAULT = 3
const MAX_ATTEMPTS_REVOKE = 5

/**
 * **凭据变更传播**（`docs/design/workspace-cli-credentials.md` §6.4.6）。
 *
 * 流程：按 owner 查工作区候选 → 批量查实时运行态（**只查不起**，避免唤醒闲置工作区）
 * → 对运行中的逐个推送同步 → 失败进重试队列。
 *
 * 推送是尽力而为、最终一致：`ensure` 时执行面会按库里的版本重新落地，
 * 所以推送失败不会让工作区永远用旧凭据，只是收敛得晚一点。
 * **吊销例外**：旧凭据仍可用，因此吊销多给重试次数，最终失败要打 error 级日志。
 */
@Injectable()
export class CredentialSyncService {
  /** 工作区 → 当前重试代数（去重：连续变更只保留一条重试链） */
  private readonly retrying = new Map<string, number>()

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(PersonalCredentialRepository)
    private readonly credentials: PersonalCredentialRepository,
    @Inject(CREDENTIAL_SYNC_PORT) private readonly port: WorkspaceSyncPort,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /** 推送一次（bind / revoke / refresh 之后调用） */
  async push(
    owner: OwnerRef,
    reason: 'bind' | 'revoke' | 'refresh',
  ): Promise<{ pushed: number; failed: number; skipped: number }> {
    const workspaces = await this.db
      .getRepository(AiWorkspaceEntity)
      .find({ where: owner, select: { id: true } })
    if (workspaces.length === 0) return { pushed: 0, failed: 0, skipped: 0 }

    const version = credentialVersionOf(await this.credentials.listActiveVersions(owner))

    // 批量查实时运行态（并发；单个失败按"没在跑"处理，不影响其它工作区）
    const statuses = await Promise.all(
      workspaces.map(async (workspace) => {
        try {
          return { id: workspace.id, state: (await this.port.status(workspace.id)).state }
        } catch {
          return { id: workspace.id, state: 'unknown' as const }
        }
      }),
    )
    const running = statuses.filter((item) => item.state === 'running').map((item) => item.id)
    const skipped = workspaces.length - running.length

    let pushed = 0
    let failed = 0
    for (const workspaceId of running) {
      try {
        await this.port.sync(workspaceId, version)
        pushed += 1
      } catch (error) {
        failed += 1
        this.scheduleRetry(workspaceId, version, reason, 1, error)
      }
    }
    if (pushed > 0 || failed > 0) {
      this.logger.log('credential.sync', {
        reason,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        version,
        pushed,
        failed,
        skipped,
      })
    }
    return { pushed, failed, skipped }
  }

  /** 失败重试：延迟递增，超过上限后对吊销打 error 级日志（普通变更交给 ensure 兜底） */
  private scheduleRetry(
    workspaceId: string,
    version: string,
    reason: 'bind' | 'revoke' | 'refresh',
    attempt: number,
    cause: unknown,
  ): void {
    const maxAttempts = reason === 'revoke' ? MAX_ATTEMPTS_REVOKE : MAX_ATTEMPTS_DEFAULT
    if (attempt > maxAttempts) {
      const detail = {
        workspaceId,
        reason,
        attempt,
        cause: cause instanceof Error ? cause.message : String(cause),
      }
      if (reason === 'revoke') this.logger.error('credential.sync_revoke_gave_up', detail)
      else this.logger.warn('credential.sync_gave_up', detail)
      this.retrying.delete(workspaceId)
      return
    }

    // 同工作区已有更新的重试链就让它跑（保持代数不倒退）
    const current = this.retrying.get(workspaceId) ?? 0
    if (current >= attempt) return
    this.retrying.set(workspaceId, attempt)

    const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]
    const timer = setTimeout(() => {
      void this.port
        .sync(workspaceId, version)
        .then(() => {
          this.retrying.delete(workspaceId)
          this.logger.log('credential.sync_retry_ok', { workspaceId, reason, attempt })
        })
        .catch((error: unknown) =>
          this.scheduleRetry(workspaceId, version, reason, attempt + 1, error),
        )
    }, delay)
    // 不阻止进程退出（重试是尽力而为）
    timer.unref?.()
  }
}
