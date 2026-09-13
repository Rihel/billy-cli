import { Module } from '@nestjs/common'
import { AdminModule } from '../admin/admin.module.js'
import { AuthModule } from '../auth/auth.module.js'
import { StreamAuthGuard } from './stream-auth.guard.js'
import { StreamController } from './stream.controller.js'
import { SSE_ROUTE_OPTIONS, type SseRouteOptions } from './stream.options.js'

/**
 * 服务端推流模块（SSE）：路由 + 鉴权守卫；推流能力本体是 kits 的 StreamHub（@Global 注入）。
 *
 * 需要换鉴权身份或放开业务频道时，改这里的 SSE_ROUTE_OPTIONS：
 *   { provide: SSE_ROUTE_OPTIONS, useValue: { auth: 'admin', allowChannel: (c) => c.startsWith('task:') } }
 */
@Module({
  imports: [AuthModule, AdminModule],
  controllers: [StreamController],
  providers: [
    StreamAuthGuard,
    {
      provide: SSE_ROUTE_OPTIONS,
      useValue: {
        auth: 'user',
        allowChannel: () => false,
      } satisfies Required<SseRouteOptions>,
    },
  ],
})
export class StreamModule {}
