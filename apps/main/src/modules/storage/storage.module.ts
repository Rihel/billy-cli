import { Module } from '@nestjs/common'
import { AdminModule } from '../admin/admin.module.js'
import { AuthModule } from '../auth/auth.module.js'
import { StorageController } from './storage.controller.js'

/**
 * 对象存储模块：只提供路由边界，能力本体是 kits 的 ObjectStorage 统一入口（@Global 注入）。
 * 存储配置（StorageConfig）由 `ObjectStorageModule.forRoot(...)` 提供（见 root.module.ts imports）。
 *
 * 鉴权用 `AuthModule` 导出的 `AnyAuthGuard`（前台用户或管理员）。
 * **两个模块都要 import**：`@UseGuards(具体类)` 属于 Nest **增强器**，它在**宿主模块**
 * （这里是 StorageModule）的注入上下文里实例化，因此 `AnyAuthGuard` 的依赖（UserAuthGuard /
 * AdminAuthGuard）必须能从本模块的 imports 里解析到 —— 只 import AuthModule 会报
 * `Nest can't resolve dependencies of the AnyAuthGuard (UserAuthGuard, ?)`。
 */
@Module({
  imports: [AuthModule, AdminModule],
  controllers: [StorageController],
})
export class StorageModule {}
