import jsonwebtoken from 'jsonwebtoken'
import { Inject, Injectable } from '@nestjs/common'
import { JwtConfig } from './jwt.config.js'
import { IdGeneration } from '../foundation/id-generation/id-generation.js'
import { TokenSigningError } from '../foundation/errors/infrastructure-errors.js'

@Injectable()
export class TokenSigner {
  constructor(
    @Inject(JwtConfig) private readonly config: JwtConfig,
    @Inject(IdGeneration) private readonly idGeneration: IdGeneration,
  ) {}

  /**
   * 签发 token。除业务声明外**必须带 `jti`（唯一 id）**：
   *
   * jsonwebtoken 只自动补 `iat` / `exp`，粒度是**秒** —— 同一个 `sub` 在同一秒内登录两次，
   * 得到的 token 会**逐字节相同**。而服务端会话以 `sha256(token)` 为主键，于是「两台设备」
   * 会被合并成一条会话（UA 互相覆盖、下线一台等于下线两台）。`jti` 本就是这个用途的标准声明，
   * 加上它才能做到「一次登录一条会话」。
   */
  async sign(payload: object): Promise<string> {
    try {
      return jsonwebtoken.sign(payload, this.config.secret, {
        expiresIn: this.config.expiresIn as never,
        jwtid: this.idGeneration.next(16),
      })
    } catch (cause) {
      throw new TokenSigningError(cause)
    }
  }

  async verify<T extends object>(token: string): Promise<T> {
    try {
      return jsonwebtoken.verify(token, this.config.secret) as T
    } catch (cause) {
      throw new TokenSigningError(cause)
    }
  }
}
