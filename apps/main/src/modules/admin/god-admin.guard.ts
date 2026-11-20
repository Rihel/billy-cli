import { Inject, Injectable, type CanActivate } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { AppErrorCodes } from '@repo/shared'
import { boundaryErrorOf } from '@repo/kits'
import { currentAdminType } from '../../common/security/index.js'
import { resolveServerConfig, type ServerConfig } from '../../config.js'

/**
 * 超管守卫：只放行 `admins.type='god'`。
 *
 * 用途是「管理员管理」这组接口（建号 / 列表 / 改类型 / 删除 / 重置密码）——
 * 普通管理员即使直接调接口也必须被拒，**菜单不可见只是交互层，不能替代接口校验**。
 *
 * `AUTH_ENABLED=false`（自托管单租户，鉴权整体关闭）时直接放行：那种部署里没有身份，
 * 也没有"谁能管理管理员"的概念。注意本守卫必须挂在 `AdminAuthGuard` **之后**。
 */
@Injectable()
export class GodAdminGuard implements CanActivate {
  private readonly server: ServerConfig

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.server = resolveServerConfig(config)
  }

  canActivate(): boolean {
    if (!this.server.authEnabled) return true
    if (currentAdminType() !== 'god') throw boundaryErrorOf(AppErrorCodes.Forbidden)
    return true
  }
}
