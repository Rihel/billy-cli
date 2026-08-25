import { Transactional, type PageQueryResult } from '@repo/db'
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
import { Inject, Injectable } from '../../composition/di.js'
import type { AppLogger } from '@repo/shared/logger'
import { Logger } from '../../foundation/logger.js'
import { PasswordHasher } from '../../infrastructure/password-hasher.js'
import { toUser, UserRepository } from './user.repository.js'
import { EmailTakenError, UserNotFoundError } from './errors.js'

@Injectable()
export class UserService {
  @Logger()
  private readonly logger!: AppLogger

  constructor(
    @Inject(UserRepository) private readonly userRepository: UserRepository,
    @Inject(PasswordHasher) private readonly passwordHasher: PasswordHasher,
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
    this.logger.log('user.updated', { id: userId })
    return toUser(user)
  }

  @Transactional()
  async remove(input: RemoveUserDto): Promise<RemoveUserResultModel> {
    const user = await this.userRepository.remove(input.userId)
    if (!user) throw new UserNotFoundError(input.userId)
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
