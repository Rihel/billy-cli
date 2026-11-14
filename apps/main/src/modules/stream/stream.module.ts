import { Module } from '@nestjs/common'
import { STREAM_ADMIN_BROADCAST_CHANNEL, STREAM_AI_OWNER_CHANNEL_PREFIX } from '@repo/shared'
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
        // 双端：前台用户（user:{id}）与后台管理员（admin:{id} + admin:all 广播）都能订阅
        auth: 'both',
        // 管理员端自动收全体管理员广播（当前为告警 alert.fired）；服务端会校验同域
        broadcastChannels: [STREAM_ADMIN_BROADCAST_CHANNEL],
        // 业务频道默认全拒，需要时在此注入归属权校验
        allowChannel: () => false,
        // AI 归属者频道：身份折叠口径与 `ai.controller.ts` 的 `ownerId()` 一致（前台用户优先）。
        // 频道由身份算出、客户端不可指定 —— 因此不需要（也不应该）走 allowChannel 校验
        derivedChannels: ({ userId, adminId }) => {
          const ownerId = userId ?? adminId
          return ownerId ? [`${STREAM_AI_OWNER_CHANNEL_PREFIX}${ownerId}`] : []
        },
      } satisfies Required<SseRouteOptions>,
    },
  ],
})
export class StreamModule {}
