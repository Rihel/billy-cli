import { Global, Module } from '@nestjs/common'
import { SessionStore } from './session-store.js'

/**
 * 会话存储模块（统一入口 `SessionStore`）：无自有配置，复用 JwtModule 的 JwtConfig
 * （会话 TTL 与 JWT 有效期一致）与 RedisModule 的 RedisStore（会话存储）。
 *
 * 命名：按**对外提供的类**命名（`StreamHub` → `StreamHubModule` 同理），因为应用侧还有一个
 * 业务模块也叫会话（`apps/server/src/modules/session`，提供登录设备列表 / 下线）。
 */
@Global()
@Module({ providers: [SessionStore], exports: [SessionStore] })
export class SessionStoreModule {}
