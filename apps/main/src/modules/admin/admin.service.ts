import {
  Transactional,
  type PageQueryResult,
  AppLogger,
  PasswordHasher,
  SessionStore,
  TokenSigner,
  currentSessionMeta,
} from '@repo/kits'
import { AdminType, UserStatus, toAdminType } from '@repo/shared'
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
import { Inject, Injectable } from '@nestjs/common'
import { InvalidOldPasswordError, InvalidTokenError } from '../auth/errors.js'
import { toAdmin, AdminRepository } from './admin.repository.js'
import { WorkspaceAdminService } from '../ai-admin/workspace/workspace.service.js'
import {
  assertAnotherAdminGod,
  assertCanChangeAdminType,
  assertCanCreateAdminType,
} from './admin-type-rules.js'
import type { AdminActor, VerifiedAdminToken } from './admin.types.js'
import {
  AdminDisabledError,
  AdminEmailTakenError,
  AdminNotFoundError,
  CannotRemoveSelfError,
  InvalidAdminCredentialsError,
} from './errors.js'

/** 管理员 token 携带 type='admin'，与前台用户 token（无 type 或 type='user'）区分 */
export const ADMIN_TOKEN_TYPE = 'admin' as const

@Injectable()
export class AdminService {
  constructor(
    @Inject(AdminRepository) private readonly adminRepository: AdminRepository,
    @Inject(PasswordHasher) private readonly passwordHasher: PasswordHasher,
    @Inject(TokenSigner) private readonly tokenSigner: TokenSigner,
    @Inject(SessionStore) private readonly sessionStore: SessionStore,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(WorkspaceAdminService) private readonly workspaces: WorkspaceAdminService,
  ) {}

  async login(input: AdminLoginDto): Promise<AdminAuthResultModel> {
    const record = await this.adminRepository.findByEmail(input.email)
    if (!record || !(await this.passwordHasher.verify(input.password, record.password))) {
      throw new InvalidAdminCredentialsError()
    }
    if (record.status !== UserStatus.Enabled) {
      throw new AdminDisabledError(record.email)
    }
    const admin = toAdmin(record)
    const adminType = toAdminType(record.type)
    // 类型同时进 JWT claim 与服务端会话：前者便于排障识别，后者才是**权威**
    // （改类型时会撤销该账号全部会话，旧 token 因此无法再带着旧身份通行）。
    const token = await this.tokenSigner.sign({
      sub: admin.id,
      type: ADMIN_TOKEN_TYPE,
      adminType,
    })
    await this.sessionStore.create(
      token,
      { sub: admin.id, type: 'admin', adminType },
      currentSessionMeta(),
    )
    this.logger.log('admin.login', { id: admin.id, adminType })
    return { token, admin }
  }

  /**
   * 校验 token 且必须是管理员 token。
   *
   * 管理员类型**只认服务端会话里的值**：升级前登记的旧会话没有该字段，按 `normal` 处理
   * （最小权限）。会话不存在 = 已登出 / 被踢下线 / 已撤销，即失效。
   */
  async verifyToken(input: { token: string }): Promise<VerifiedAdminToken> {
    try {
      const payload = await this.tokenSigner.verify<{
        sub: string
        type?: string
      }>(input.token)
      if (payload.type !== ADMIN_TOKEN_TYPE) throw new InvalidTokenError()
      // 服务端会话校验：登出 / 禁用 / 删除 / 类型变更后会话已撤销，token 立即失效
      const session = await this.sessionStore.verify(input.token)
      if (!session || session.type !== 'admin' || session.sub !== payload.sub) {
        throw new InvalidTokenError()
      }
      return { adminId: payload.sub, adminType: toAdminType(session.adminType) }
    } catch {
      throw new InvalidTokenError()
    }
  }

  /** 登出：撤销服务端会话（幂等） */
  async logout(input: { token: string }): Promise<SuccessResultModel> {
    await this.sessionStore.revoke(input.token)
    this.logger.log('admin.logout')
    return { success: true }
  }

  async getMe(input: { adminId: string }): Promise<AdminModel> {
    const admin = await this.adminRepository.findById(input.adminId)
    if (!admin) throw new AdminNotFoundError(input.adminId)
    return toAdmin(admin)
  }

  /**
   * 建管理员。
   *
   * **刻意不加 `@Transactional()`**：默认工作区是"尽力而为"的附属动作（失败只告警，
   * 由补偿任务补）。把它和建号放在同一个事务里，一旦它失败，Postgres 会把事务打成
   * aborted，随后的 COMMIT 变成回滚 —— 账号静默消失，而接口仍返回成功（踩过）。
   */
  async create(input: CreateAdminDto, actor?: AdminActor): Promise<AdminModel> {
    // 普通管理员不能自己造超管；系统调用（actor 缺失）不受限
    assertCanCreateAdminType(actor, input.type)
    const existing = await this.adminRepository.findByEmail(input.email)
    if (existing) throw new AdminEmailTakenError(input.email)
    const hashed = await this.passwordHasher.hash(input.password)
    const admin = toAdmin(await this.adminRepository.create({ ...input, password: hashed }))
    // 默认工作区：建号即建记录（容器懒启动）。失败不阻塞建号，补偿任务会补。
    await this.workspaces
      .ensureDefault({ ownerType: 'admin', ownerId: admin.id })
      .catch((error: unknown) => {
        this.logger.warn('admin.default_workspace_failed', {
          id: admin.id,
          reason: error instanceof Error ? error.message : String(error),
        })
      })
    this.logger.log('admin.created', { id: admin.id, adminType: admin.type })
    return admin
  }

  /**
   * 确保存在一个超级管理员（环境变量种子与运维脚本共用的**同一段逻辑**）。
   *
   * - 邮箱不存在 → 直接建成 `god`；
   * - 邮箱已存在 → 只把类型升为 `god`，**不覆盖密码**（人可能已经改过），并撤销其旧会话
   *   （旧 token 带着旧身份，必须重新登录才生效）。
   *
   * 迁移与种子服务必须同版本发布：否则既有管理员全部是 `normal`，「管理员管理」无人可用。
   */
  @Transactional()
  async seedGod(input: {
    email: string
    password: string
    realName?: string
  }): Promise<{ admin: AdminModel; created: boolean }> {
    const existing = await this.adminRepository.findByEmail(input.email)
    if (existing) {
      if (existing.type !== AdminType.God) {
        await this.adminRepository.update(existing.id, { type: AdminType.God })
        await this.sessionStore.revokeAll('admin', existing.id)
        this.logger.log('admin.god.upgraded', { id: existing.id, email: existing.email })
      }
      // `Object.assign` 而不是 `{ ...existing }`：实体是类实例，展开会丢掉 `generateId()` 等方法
      return { admin: toAdmin(Object.assign(existing, { type: AdminType.God })), created: false }
    }
    const admin = await this.create({ ...input, type: AdminType.God })
    return { admin, created: true }
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
  async update(input: UpdateAdminDto, actor?: AdminActor): Promise<AdminModel> {
    const current = await this.adminRepository.findById(input.adminId)
    if (!current) throw new AdminNotFoundError(input.adminId)

    const nextType = input.type
    const typeChanged = nextType !== undefined && nextType !== current.type
    if (nextType !== undefined && typeChanged) {
      // 两道闸门：谁能改类型、不能把最后一个超管降级（后者不查库就没法判，故在这里取计数）
      const livingGods =
        current.type === AdminType.God ? await this.adminRepository.countByType(AdminType.God) : 0
      assertCanChangeAdminType({
        actor,
        currentType: current.type,
        nextType,
        livingGods,
      })
    }

    const { adminId, ...changes } = input
    const admin = await this.adminRepository.update(adminId, changes)
    if (!admin) throw new AdminNotFoundError(adminId)
    // 禁用管理员：立即撤销其全部会话，踢下线
    if (changes.status === 'disabled') {
      await this.sessionStore.revokeAll('admin', adminId)
    }
    // 类型变更：旧会话里的身份已作废，必须重新登录
    if (typeChanged) {
      await this.sessionStore.revokeAll('admin', adminId)
      this.logger.log('admin.typeChanged', { id: adminId, from: current.type, to: input.type })
    }
    this.logger.log('admin.updated', { id: adminId })
    return toAdmin(admin)
  }

  @Transactional()
  async updateInfo(input: AdminUpdateInfoDto & { adminId: string }): Promise<AdminModel> {
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
    const target = await this.adminRepository.findById(adminId)
    if (!target) throw new AdminNotFoundError(adminId)
    if (target.type === AdminType.God) {
      assertAnotherAdminGod(await this.adminRepository.countByType(AdminType.God))
    }
    const admin = await this.adminRepository.remove(adminId)
    if (!admin) throw new AdminNotFoundError(adminId)
    // 删除管理员：撤销其全部会话
    await this.sessionStore.revokeAll('admin', adminId)
    this.logger.log('admin.removed', { id: adminId })
    return { success: true }
  }

  @Transactional()
  async resetPassword(input: ResetAdminPasswordDto): Promise<SuccessResultModel> {
    const hashed = await this.passwordHasher.hash(input.password)
    const admin = await this.adminRepository.update(input.adminId, {
      password: hashed,
    })
    if (!admin) throw new AdminNotFoundError(input.adminId)
    this.logger.log('admin.passwordReset', { id: input.adminId })
    return { success: true }
  }
}
