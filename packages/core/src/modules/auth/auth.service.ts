import { Transactional } from '@repo/db'
import { dayjs, nanoid } from '@repo/shared'
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
import { Inject, Injectable } from '../../composition/di.js'
import { AppConfig } from '../../foundation/app-config.js'
import type { AppLogger } from '@repo/shared/logger'
import { Logger } from '../../foundation/logger.js'
import { PasswordHasher } from '../../infrastructure/password-hasher.js'
import { TokenSigner } from '../../infrastructure/token-signer.js'
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
} from './errors.js'

@Injectable()
export class AuthService {
  @Logger()
  private readonly logger!: AppLogger

  constructor(
    @Inject(UserRepository) private readonly userRepository: UserRepository,
    @Inject(PasswordHasher) private readonly passwordHasher: PasswordHasher,
    @Inject(TokenSigner) private readonly tokenSigner: TokenSigner,
    @Inject(AppConfig) private readonly config: AppConfig,
  ) {}

  @Transactional()
  async register(input: RegisterDto): Promise<AuthResultModel> {
    const existing = await this.userRepository.findByEmail(input.email)
    if (existing) throw new EmailTakenError(input.email)
    const hashed = await this.passwordHasher.hash(input.password)
    const user = toUser(
      await this.userRepository.create({ ...input, password: hashed }),
    )
    const token = await this.tokenSigner.sign({ sub: user.id })
    this.logger.log('auth.registered', { id: user.id })
    return { token, user }
  }

  async login(input: LoginDto): Promise<AuthResultModel> {
    const record = await this.userRepository.findByEmail(input.email)
    if (!record) throw new EmailNotFoundError(input.email)
    if (!(await this.passwordHasher.verify(input.password, record.password))) {
      throw new InvalidCredentialsError()
    }
    const user = toUser(record)
    const token = await this.tokenSigner.sign({ sub: user.id })
    this.logger.log('auth.login', { id: user.id })
    return { token, user }
  }

  @Transactional()
  async forgotPassword(input: ForgotPasswordDto): Promise<SuccessResultModel> {
    const user = await this.userRepository.findByEmail(input.email)
    if (!user) {
      this.logger.warn('auth.forgotPassword.userNotFound')
      return { success: true }
    }
    const token = nanoid(32)
    await this.userRepository.update(user.id, {
      resetPasswordToken: token,
      resetPasswordTokenExpiry: dayjs()
        .add(this.config.auth.resetPasswordTokenTtlMinutes, 'minute')
        .toDate(),
    })
    return { success: true, token }
  }

  @Transactional()
  async resetPassword(input: ResetPasswordDto): Promise<SuccessResultModel> {
    const user = await this.userRepository.findByResetToken(input.token)
    if (!user) throw new InvalidResetTokenError()
    if (
      !user.resetPasswordTokenExpiry ||
      dayjs().isAfter(user.resetPasswordTokenExpiry)
    ) {
      throw new ExpiredResetTokenError()
    }
    const hashed = await this.passwordHasher.hash(input.password)
    await this.userRepository.update(user.id, {
      password: hashed,
      resetPasswordToken: null,
      resetPasswordTokenExpiry: null,
    })
    return { success: true }
  }

  async getMe(input: { userId: string }): Promise<AuthUserModel> {
    const user = await this.userRepository.findById(input.userId)
    if (!user) throw new UserNotFoundError(input.userId)
    return toUser(user)
  }

  @Transactional()
  async updateInfo(
    input: UpdateInfoDto & { userId: string },
  ): Promise<AuthUserModel> {
    const { userId, ...changes } = input
    const user = await this.userRepository.update(userId, changes)
    if (!user) throw new UserNotFoundError(userId)
    this.logger.log('auth.updateInfo', { id: userId })
    return toUser(user)
  }

  @Transactional()
  async changePassword(
    input: ChangePasswordDto & { userId: string },
  ): Promise<SuccessResultModel> {
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
      return payload.sub
    } catch {
      throw new InvalidTokenError()
    }
  }
}
