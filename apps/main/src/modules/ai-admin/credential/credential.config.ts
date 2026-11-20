import type { ConfigService } from '@nestjs/config'
import { EnvelopeCipher } from '@repo/kits'
import type { ServerAppConfig } from '../../../app-config.js'

/** 凭据模块的配置 bean 令牌（模块装配时 `useFactory` 产出，业务层注入它） */
export const CREDENTIAL_CONFIG = Symbol('CREDENTIAL_CONFIG')

/** 凭据模块的配置：目前只有信封加密器（密钥环在构造期校验，配错直接启动失败） */
export interface CredentialModuleConfig {
  /**
   * 信封加密器。
   *
   * `configured === false` 表示还没配主密钥：服务可以起（与对象存储同一套可降级口径），
   * 但任何写入都必须明确报错，**绝不落明文**。
   */
  cipher: EnvelopeCipher
  /**
   * `/internal/credentials/resolve` 的内部令牌。
   *
   * 与 `TOOL_INTERNAL_TOKEN` 同值：调用方是能力网关 / workspace-service，
   * 它们本来就持有这个令牌，不必为凭据再加一套密钥分发。
   */
  internalToken: string
}

/**
 * 从应用配置装配加密器（密钥环在 `app-config` 的 schema 里已校验过长度，
 * `EnvelopeCipher` 构造时再校一次，防止绕过配置校验的调用方）。
 */
export const createCredentialConfig = (config: ConfigService): CredentialModuleConfig => {
  const credential = config.getOrThrow<ServerAppConfig['credential']>('credential')
  return {
    cipher: new EnvelopeCipher({ keys: credential.keys, current: credential.current }),
    internalToken: process.env.TOOL_INTERNAL_TOKEN?.trim() || 'dev-tool-token',
  }
}
