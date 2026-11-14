import { Module } from '@nestjs/common'
import { AdminModule } from '../admin/admin.module.js'
import { AuthModule } from '../auth/auth.module.js'
import { ShareController } from './share.controller.js'
import { ShareRepository } from './share.repository.js'
import { ShareService } from './share.service.js'

/**
 * 文件分享模块（设计 `docs/design/file-share.md`）。
 *
 * - 依赖 `AuthModule` + `AdminModule`：`AnyAuthGuard` 在本模块上下文里实例化，
 *   它的 `UserAuthGuard` / `AdminAuthGuard` 必须能从 imports 解析到（与 session 模块同一写法）；
 * - `ObjectStorage` / `ConfigService` / `Db` 都是全局注入，无需在这里 imports。
 */
@Module({
  imports: [AuthModule, AdminModule],
  controllers: [ShareController],
  providers: [ShareService, ShareRepository],
})
export class ShareModule {}
