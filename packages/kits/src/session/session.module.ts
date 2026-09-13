import { Global, Module } from '@nestjs/common'
import { SessionStore } from './session-store.js'

/**
 * 会话模块：无自有配置，复用 JwtModule 的 JwtConfig（会话 TTL 与 JWT 有效期一致）
 * 与 RedisModule 的 RedisStore（会话存储）。
 */
@Global()
@Module({ providers: [SessionStore], exports: [SessionStore] })
export class SessionModule {}
