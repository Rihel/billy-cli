import { Module } from '@nestjs/common'
import { AdminModule } from '../admin/admin.module.js'
import { StorageController } from './storage.controller.js'

/**
 * 对象存储模块：只提供路由边界，能力本体是 kits 的 ObjectStorage 门面（@Global 注入）。
 * 存储配置（StorageConfig）由 `ObjectStorageModule.forRoot(...)` 提供（见 root.module.ts imports）。
 */
@Module({
  imports: [AdminModule],
  controllers: [StorageController],
})
export class StorageModule {}
