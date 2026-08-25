import { Transactional, type PageQueryResult } from '@repo/db'
import { UserStatus } from '@repo/shared'
import type {
  AdminAuthResultModel,
  AdminLoginDto,
  AdminModel,
  AdminUpdateInfoDto,
  ChangePasswordDto,
  CreateAdminDto,
  GetAdminDetailDto,
  PageQueryAdminDto,
  RemoveAdminDto,
  ResetAdminPasswordDto,
  SuccessResultModel,
  UpdateAdminDto,
} from '@repo/shared'
import { inject, injectable } from 'inversify'
import type { AppLogger } from '@repo/shared/logger'
import { Logger } from '../../shared/logger.decorator.js'
import { PasswordHasher } from '../../shared/password-hasher.js'
import { TokenSigner } from '../../shared/token-signer.js'
import { InvalidOldPasswordError, InvalidTokenError } from '../auth/errors.js'
import { toAdmin, AdminRepository } from './admin.repository.js'
import {
  AdminDisabledError,
  AdminEmailTakenError,
  AdminNotFoundError,
  CannotRemoveSelfError,
  InvalidAdminCredentialsError,
} from './errors.js'

/** 管理员 token 携带 type='admin'，与前台用户 token（无 type 或 type='user'）区分 */
export const ADMIN_TOKEN_TYPE = 'admin' as const

@injectable()
export class AdminService {
  @Logger()
  private readonly logger!: AppLogger

  constructor(
    @inject(AdminRepository) private readonly adminRepository: AdminRepository,
    @inject(PasswordHasher) private readonly passwordHasher: PasswordHasher,
    @inject(TokenSigner) private readonly tokenSigner: TokenSigner,
  ) {}

  async login(input: AdminLoginDto): Promise<AdminAuthResultModel> {
    const record = await this.adminRepository.findByEmail(input.email)
    if (
      !record ||
      !(await this.passwordHasher.verify(input.password, record.password))
    ) {
      throw new InvalidAdminCredentialsError()
    }
    if (record.status !== UserStatus.Enabled) {
      throw new AdminDisabledError(record.email)
    }
    const admin = toAdmin(record)
    const token = await this.tokenSigner.sign({
      sub: admin.id,
      type: ADMIN_TOKEN_TYPE,
    })
    this.logger.log('admin.login', { id: admin.id })
    return { token, admin }
  }

  /** 校验 token 且必须是管理员 token，返回 adminId */
  async verifyToken(input: { token: string }): Promise<string> {
    try {
      const payload = await this.tokenSigner.verify<{
        sub: string
        type?: string
      }>(input.token)
      if (payload.type !== ADMIN_TOKEN_TYPE) throw new InvalidTokenError()
      return payload.sub
    } catch {
      throw new InvalidTokenError()
    }
  }

  async getMe(input: { adminId: string }): Promise<AdminModel> {
    const admin = await this.adminRepository.findById(input.adminId)
    if (!admin) throw new AdminNotFoundError(input.adminId)
    return toAdmin(admin)
  }

  @Transactional()
  async create(input: CreateAdminDto): Promise<AdminModel> {
    const existing = await this.adminRepository.findByEmail(input.email)
    if (existing) throw new AdminEmailTakenError(input.email)
    const hashed = await this.passwordHasher.hash(input.password)
    const admin = toAdmin(
      await this.adminRepository.create({ ...input, password: hashed }),
    )
    this.logger.log('admin.created', { id: admin.id })
    return admin
  }

  async get(input: GetAdminDetailDto): Promise<AdminModel> {
    const admin = await this.adminRepository.findById(input.adminId)
    if (!admin) throw new AdminNotFoundError(input.adminId)
    return toAdmin(admin)
  }

  async page(query: PageQueryAdminDto): Promise<PageQueryResult<AdminModel>> {
    return this.adminRepository.page(query)
  }

  @Transactional()
  async update(input: UpdateAdminDto): Promise<AdminModel> {
    const { adminId, ...changes } = input
    const admin = await this.adminRepository.update(adminId, changes)
    if (!admin) throw new AdminNotFoundError(adminId)
    this.logger.log('admin.updated', { id: adminId })
    return toAdmin(admin)
  }

  @Transactional()
  async updateInfo(
    input: AdminUpdateInfoDto & { adminId: string },
  ): Promise<AdminModel> {
    const { adminId, ...changes } = input
    const admin = await this.adminRepository.update(adminId, changes)
    if (!admin) throw new AdminNotFoundError(adminId)
    this.logger.log('admin.updateInfo', { id: adminId })
    return toAdmin(admin)
  }

  @Transactional()
  async changePassword(
    input: ChangePasswordDto & { adminId: string },
  ): Promise<SuccessResultModel> {
    const { adminId, oldPassword, newPassword } = input
    const admin = await this.adminRepository.findById(adminId)
    if (!admin) throw new AdminNotFoundError(adminId)
    if (!(await this.passwordHasher.verify(oldPassword, admin.password))) {
      throw new InvalidOldPasswordError()
    }
    const hashed = await this.passwordHasher.hash(newPassword)
    await this.adminRepository.update(adminId, { password: hashed })
    this.logger.log('admin.changePassword', { id: adminId })
    return { success: true }
  }

  @Transactional()
  async remove(input: RemoveAdminDto & { operatorId: string }): Promise<SuccessResultModel> {
    const { adminId, operatorId } = input
    if (adminId === operatorId) throw new CannotRemoveSelfError()
    const admin = await this.adminRepository.remove(adminId)
    if (!admin) throw new AdminNotFoundError(adminId)
    this.logger.log('admin.removed', { id: adminId })
    return { success: true }
  }

  @Transactional()
  async resetPassword(
    input: ResetAdminPasswordDto,
  ): Promise<SuccessResultModel> {
    const hashed = await this.passwordHasher.hash(input.password)
    const admin = await this.adminRepository.update(input.adminId, {
      password: hashed,
    })
    if (!admin) throw new AdminNotFoundError(input.adminId)
    this.logger.log('admin.passwordReset', { id: input.adminId })
    return { success: true }
  }
}
