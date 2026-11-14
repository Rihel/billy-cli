import { createHash } from 'node:crypto'
import { Transactional } from '@repo/kits'
import { dayjs, nanoid, UserStatus } from '@repo/shared'
import type {
  AuthResultModel,
  AuthUserModel,
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  SuccessResultModel,
  UpdateInfoDto,
} from '@repo/shared'
import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, Notifier } from '@repo/kits'
import { PasswordHasher } from '@repo/kits'
import { SessionStore } from '@repo/kits'
import { TokenSigner } from '@repo/kits'
import { ConfigService } from '@nestjs/config'
import { currentSessionMeta } from '../../common/index.js'
import { resolveServerConfig, type ServerConfig } from '../../config.js'
import { toUser, UserRepository } from '../user/user.repository.js'
import { EmailTakenError, UserNotFoundError } from '../user/errors.js'
import {
  EmailNotFoundError,
  ExpiredResetTokenError,
  InvalidCredentialsError,
  InvalidOldPasswordError,
  InvalidResetTokenError,
  InvalidTokenError,
  PasswordUnchangedError,
  UserDisabledError,
} from './errors.js'

/**
 * 重置令牌只落 **sha256 哈希**（与分享 token、会话键同口径）。
 *
 * 令牌本身是高熵随机串，不需要慢哈希；用 sha256 的意义是「库被读走也拿不到可用令牌」。
 * 明文只出现两次：写进邮件链接、用户点链接带回 —— 都不进响应体、不进日志。
 */
const hashResetToken = (token: string): string => createHash('sha256').update(token).digest('hex')

@Injectable()
export class AuthService {
  /** 应用级业务配置（bootstrap 前已加载校验，构造期解析一次即可） */
  private readonly server: ServerConfig

  constructor(
    @Inject(UserRepository) private readonly userRepository: UserRepository,
    @Inject(PasswordHasher) private readonly passwordHasher: PasswordHasher,
    @Inject(TokenSigner) private readonly tokenSigner: TokenSigner,
    @Inject(SessionStore) private readonly sessionStore: SessionStore,
    @Inject(ConfigService) config: ConfigService,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(Notifier) private readonly notifier: Notifier,
  ) {
    this.server = resolveServerConfig(config)
  }

  @Transactional()
  async register(input: RegisterDto): Promise<AuthResultModel> {
    const existing = await this.userRepository.findByEmail(input.email)
    if (existing) throw new EmailTakenError(input.email)
    const hashed = await this.passwordHasher.hash(input.password)
    const user = toUser(await this.userRepository.create({ ...input, password: hashed }))
    const token = await this.tokenSigner.sign({ sub: user.id })
    await this.sessionStore.create(token, { sub: user.id, type: 'user' }, currentSessionMeta())
    this.logger.log('auth.registered', { id: user.id })
    return { token, user }
  }

  async login(input: LoginDto): Promise<AuthResultModel> {
    const record = await this.userRepository.findByEmail(input.email)
    if (!record) throw new EmailNotFoundError(input.email)
    if (!(await this.passwordHasher.verify(input.password, record.password))) {
      throw new InvalidCredentialsError()
    }
    if (record.status !== UserStatus.Enabled) {
      throw new UserDisabledError(record.email)
    }
    const user = toUser(record)
    const token = await this.tokenSigner.sign({ sub: user.id })
    await this.sessionStore.create(token, { sub: user.id, type: 'user' }, currentSessionMeta())
    this.logger.log('auth.login', { id: user.id })
    return { token, user }
  }

  /**
   * 找回密码：生成令牌 → **只存哈希** → 经邮件投递重置链接。
   *
   * 安全口径（2026-11-14 评审整改）：
   * - API 响应**绝不回传令牌**，且用户不存在时与成功响应完全一致（不泄露账号是否存在）；
   * - 令牌明文只进邮件链接；库里存 `sha256(token)`，有效期由配置控制；
   * - 邮件未配置 / 发送失败不算业务失败（避免枚举），但**生产环境绝不把链接写日志**，
   *   本地开发（`NODE_ENV !== 'production'`）才把链接写进 warn，便于自测。
   * - 不加 `@Transactional()`：单行更新，没必要在发 SMTP 期间占着数据库事务。
   */
  async forgotPassword(input: ForgotPasswordDto): Promise<SuccessResultModel> {
    const user = await this.userRepository.findByEmail(input.email)
    if (!user) {
      this.logger.warn('auth.forgotPassword.userNotFound')
      return { success: true }
    }

    const token = nanoid(32)
    await this.userRepository.update(user.id, {
      resetPasswordToken: hashResetToken(token),
      resetPasswordTokenExpiry: dayjs()
        .add(this.server.resetPasswordTokenTtlMinutes, 'minute')
        .toDate(),
    })

    const link = `${this.server.appUrl.replace(/\/+$/, '')}/auth/reset-password?token=${encodeURIComponent(token)}`
    const sent = await this.notifier
      .send('email', {
        to: user.email,
        subject: '重置你的登录密码',
        text: [
          `你（或有人）在 ${this.server.appUrl} 申请重置密码。`,
          `请点击下面的链接设置新密码（${this.server.resetPasswordTokenTtlMinutes} 分钟内有效）：`,
          link,
          '',
          '如果不是你本人操作，忽略这封邮件即可，你的密码不会被修改。',
        ].join('\n'),
      })
      .catch((cause: unknown) => ({
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }))

    if (!sent.ok) {
      // 生产环境连链接都不能进日志（日志可能被集中采集）；本地开发才输出便于自测
      if (process.env.NODE_ENV !== 'production') {
        this.logger.warn('auth.forgotPassword.emailNotSent', { link, error: sent.error })
      } else {
        this.logger.error('auth.forgotPassword.emailNotSent', { error: sent.error })
      }
    }
    this.logger.log('auth.forgotPassword.requested', { id: user.id })
    return { success: true }
  }

  /**
   * 重置密码：只改一行（密码 + 清空令牌），没有多语句原子性需求，故不开事务；
   * 会话撤销走 Redis，不在数据库事务边界内（撤失败也不该回滚已改的密码）。
   */
  async resetPassword(input: ResetPasswordDto): Promise<SuccessResultModel> {
    // 库里存的是哈希：先用同样的规则哈希再查
    const user = await this.userRepository.findByResetTokenHash(hashResetToken(input.token))
    if (!user) throw new InvalidResetTokenError()
    if (!user.resetPasswordTokenExpiry || dayjs().isAfter(user.resetPasswordTokenExpiry)) {
      throw new ExpiredResetTokenError()
    }
    const hashed = await this.passwordHasher.hash(input.password)
    await this.userRepository.update(user.id, {
      password: hashed,
      resetPasswordToken: null,
      resetPasswordTokenExpiry: null,
    })
    // 密码已重置：该用户的所有登录会话立即失效（防止旧 token 继续可用）
    await this.sessionStore.revokeAll('user', user.id)
    this.logger.log('auth.resetPassword', { id: user.id })
    return { success: true }
  }

  async getMe(input: { userId: string }): Promise<AuthUserModel> {
    const user = await this.userRepository.findById(input.userId)
    if (!user) throw new UserNotFoundError(input.userId)
    return toUser(user)
  }

  @Transactional()
  async updateInfo(input: UpdateInfoDto & { userId: string }): Promise<AuthUserModel> {
    const { userId, ...changes } = input
    const user = await this.userRepository.update(userId, changes)
    if (!user) throw new UserNotFoundError(userId)
    this.logger.log('auth.updateInfo', { id: userId })
    return toUser(user)
  }

  @Transactional()
  async changePassword(input: ChangePasswordDto & { userId: string }): Promise<SuccessResultModel> {
    const { userId, oldPassword, newPassword } = input
    const user = await this.userRepository.findById(userId)
    if (!user) throw new UserNotFoundError(userId)
    if (!(await this.passwordHasher.verify(oldPassword, user.password))) {
      throw new InvalidOldPasswordError()
    }
    if (await this.passwordHasher.verify(newPassword, user.password)) {
      throw new PasswordUnchangedError()
    }
    const hashed = await this.passwordHasher.hash(newPassword)
    await this.userRepository.update(userId, { password: hashed })
    this.logger.log('auth.changePassword', { id: userId })
    return { success: true }
  }

  async verifyToken(input: { token: string }): Promise<string> {
    try {
      const payload = await this.tokenSigner.verify<{
        sub: string
        type?: string
      }>(input.token)
      // 后台管理员 token（type='admin'）不允许用于前台用户接口
      if (payload.type === 'admin') throw new InvalidTokenError()
      // 服务端会话校验：登出 / 禁用 / 删除后会话已撤销，token 立即失效
      const session = await this.sessionStore.verify(input.token)
      if (!session || session.type !== 'user' || session.sub !== payload.sub) {
        throw new InvalidTokenError()
      }
      return payload.sub
    } catch {
      throw new InvalidTokenError()
    }
  }

  /** 登出：撤销服务端会话（幂等） */
  async logout(input: { token: string }): Promise<SuccessResultModel> {
    await this.sessionStore.revoke(input.token)
    this.logger.log('auth.logout')
    return { success: true }
  }
}
