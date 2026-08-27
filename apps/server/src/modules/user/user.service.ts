import { Transactional, type PageQueryResult } from '@repo/kits'
import type {
  CreateUserDto,
  GetUserDetailDto,
  PageQueryUserDto,
  RemoveUserDto,
  RemoveUserResultModel,
  ResetUserPasswordDto,
  UpdateUserDto,
  UserModel,
} from '@repo/shared'
import { Inject, Injectable } from '@repo/di'
import type { AppLogger } from '@repo/shared/logger'
import { Logger } from '@repo/kits'
import { PasswordHasher } from '@repo/kits'
import { SessionStore } from '@repo/kits'
import { toUser, UserRepository } from './user.repository.js'
import { EmailTakenError, UserNotFoundError } from './errors.js'

@Injectable()
export class UserService {
  @Logger()
  private readonly logger!: AppLogger

  constructor(
    @Inject(UserRepository) private readonly userRepository: UserRepository,
    @Inject(PasswordHasher) private readonly passwordHasher: PasswordHasher,
    @Inject(SessionStore) private readonly sessionStore: SessionStore,
  ) {}

  @Transactional()
  async create(input: CreateUserDto): Promise<UserModel> {
    const existing = await this.userRepository.findByEmail(input.email)
    if (existing) throw new EmailTakenError(input.email)
    const hashed = await this.passwordHasher.hash(input.password)
    const user = toUser(
      await this.userRepository.create({ ...input, password: hashed }),
    )
    this.logger.log('user.created', { id: user.id })
    return user
  }

  async get(input: GetUserDetailDto): Promise<UserModel> {
    const user = await this.userRepository.findById(input.userId)
    if (!user) throw new UserNotFoundError(input.userId)
    return toUser(user)
  }

  async page(query: PageQueryUserDto): Promise<PageQueryResult<UserModel>> {
    return this.userRepository.page(query)
  }

  @Transactional()
  async update(input: UpdateUserDto): Promise<UserModel> {
    const { userId, ...changes } = input
    const user = await this.userRepository.update(userId, changes)
    if (!user) throw new UserNotFoundError(userId)
    // 禁用用户：立即撤销其全部会话，踢下线
    if (changes.status === 'disabled') {
      await this.sessionStore.revokeAll('user', userId)
    }
    this.logger.log('user.updated', { id: userId })
    return toUser(user)
  }

  @Transactional()
  async remove(input: RemoveUserDto): Promise<RemoveUserResultModel> {
    const user = await this.userRepository.remove(input.userId)
    if (!user) throw new UserNotFoundError(input.userId)
    // 删除用户：撤销其全部会话
    await this.sessionStore.revokeAll('user', input.userId)
    this.logger.log('user.removed', { id: input.userId })
    return { success: true }
  }

  @Transactional()
  async resetPassword(
    input: ResetUserPasswordDto,
  ): Promise<RemoveUserResultModel> {
    const hashed = await this.passwordHasher.hash(input.password)
    const user = await this.userRepository.update(input.userId, {
      password: hashed,
    })
    if (!user) throw new UserNotFoundError(input.userId)
    this.logger.log('user.passwordReset', { id: input.userId })
    return { success: true }
  }
}
