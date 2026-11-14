import { Module } from '@nestjs/common'
import { OpsController } from './ops.controller.js'

/**
 * 运维探针模块：根路径 `GET /healthz`（liveness）、`GET /readyz`（readiness）、`GET /info`。
 *
 * 免鉴权（探针不能带 token），也不 import 业务模块：`Db` / `RedisStore` 由 `@Global` 的
 * `DbModule` / `RedisModule` 提供，故意不挂任何守卫。
 */
@Module({
  controllers: [OpsController],
})
export class OpsModule {}
