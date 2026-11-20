import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { AdminType } from '@repo/shared'
import { AppLogger } from '@repo/kits'
import { resolveServerConfig, type ServerConfig } from '../../config.js'
import { AdminRepository } from './admin.repository.js'
import { AdminService } from './admin.service.js'

/** 与注册接口同款的密码强度下限（`RegisterSchema.password` 的 `min(6)`） */
const MIN_PASSWORD_LENGTH = 6

/**
 * **首个超级管理员种子服务**（`docs/design/workspace-cli-credentials.md` §6.10.1）。
 *
 * 为什么需要它：迁移只给 `admins` 加 `type` 列，**不在迁移里写死账号**（邮箱密码无法跨环境
 * 复用，账号被删后也无法再次初始化）。没有超管时「管理员管理」无人可用，因此用环境变量
 * 在启动时补一个。
 *
 * 触发条件（全部满足才做）：
 * 1. `ADMIN_SEED_FROM_ENV`（`server.adminSeedFromEnv`）为真；
 * 2. `GOD_ADMIN_EMAIL` 与 `GOD_ADMIN_PASSWORD` 都非空；
 * 3. 库里**没有存活超管**；
 * 4. 含软删的超管计数为 0 —— 曾经有、后来被删，只告警不自动重建
 *    （自动重建会覆盖运维的删除意图，恢复通道是运维脚本 `pnpm seed:admin`）。
 *
 * 失败不阻塞启动：后台无法登录属可接受状态，启动失败不可接受。
 */
@Injectable()
export class AdminSeedService implements OnApplicationBootstrap {
  private readonly server: ServerConfig

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(AdminRepository) private readonly admins: AdminRepository,
    @Inject(AdminService) private readonly adminService: AdminService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    this.server = resolveServerConfig(config)
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.server.adminSeedFromEnv) return

    const email = process.env.GOD_ADMIN_EMAIL?.trim()
    const password = process.env.GOD_ADMIN_PASSWORD?.trim()
    if (!email || !password) return

    try {
      if (await this.hasLivingGod()) return
      const ever = await this.admins.countByTypeIncludingDeleted(AdminType.God)
      if (ever > 0) {
        this.logger.warn('admin.god.removed', {
          message: '检测到超管已被删除，按运维意图不自动重建；恢复请用 pnpm seed:admin',
        })
        return
      }
      // 密码强度与注册同款：不达标宁可不起超管，也不能种一个弱口令后门
      if (password.length < MIN_PASSWORD_LENGTH) {
        this.logger.warn('admin.god.weak_password', {
          message: `GOD_ADMIN_PASSWORD 长度不足 ${MIN_PASSWORD_LENGTH} 位，已跳过超管种子`,
        })
        return
      }

      const { admin, created } = await this.adminService.seedGod({ email, password })
      // 日志只记邮箱，不记密码与 hash
      this.logger.log(created ? 'admin.god.seeded' : 'admin.god.upgraded', {
        email: admin.email,
        id: admin.id,
      })
    } catch (error) {
      this.logger.error('超管种子初始化失败（已跳过，不影响启动）', { error })
    }
  }

  private async hasLivingGod(): Promise<boolean> {
    const alive = await this.admins.countByType(AdminType.God)
    return alive > 0
  }
}
