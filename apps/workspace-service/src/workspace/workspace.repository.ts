import { Inject, Injectable } from '@nestjs/common'
import { Db } from '@repo/kits'
import {
  AdminEntity,
  AiSkillEntity,
  AiSkillFileEntity,
  AiSkillGrantEntity,
  AiWorkspaceEntity,
  AiWorkspaceSetupEntity,
  PersonalCredentialEntity,
} from '@repo/db'
import { CredentialStatus } from '@repo/shared'
import {
  skillSetVersionOf as computeSkillSetVersion,
  visibleSkillsOf,
  type SkillGrantRow,
  type SkillRow,
} from './skill-visibility.js'
import type { WorkspaceConfig } from '@repo/contracts'

/**
 * `ai_workspaces` 的**只读**访问。
 *
 * 写方是 main（配置 / desired_status / 软删）；执行面只读配置去起容器，
 * 运行态不写回（见 `docs/design/workspace.md` §7）。
 */
@Injectable()
export class WorkspaceRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  async findConfig(workspaceId: string): Promise<WorkspaceConfig | null> {
    const row = await this.db
      .getRepository(AiWorkspaceEntity)
      .findOne({ where: { id: workspaceId } })
    if (!row) return null
    return {
      id: row.id,
      name: row.name,
      // 驱动优先：host → local，container / pod → container；没填 driver 才回落到旧列
      backend:
        row.driver === 'host'
          ? 'local'
          : row.driver === 'container' || row.driver === 'pod'
            ? 'container'
            : (row.backend as WorkspaceConfig['backend']),
      image: row.image ?? undefined,
      ...(row.driver === 'host' || row.driver === 'container' || row.driver === 'pod'
        ? { driver: row.driver }
        : {}),
      location: (row.location ?? undefined) as WorkspaceConfig['location'],
      fileAccess: row.fileAccess as WorkspaceConfig['fileAccess'],
    }
  }

  /** 初始化的归属与清单引用（工作区行上的 `setup_id` / `setup_extra`） */
  async findSetupContext(workspaceId: string): Promise<WorkspaceSetupContext | null> {
    const row = await this.db.getRepository(AiWorkspaceEntity).findOne({
      where: { id: workspaceId },
      select: { ownerType: true, ownerId: true, setupId: true, setupExtra: true },
    })
    if (!row) return null
    return {
      ownerType: row.ownerType === 'user' ? 'user' : 'admin',
      ownerId: row.ownerId,
      setupId: row.setupId,
      setupExtra: row.setupExtra ?? [],
    }
  }

  /** 按 id 取清单（工作区显式指定时） */
  async findSetupById(id: string): Promise<AiWorkspaceSetupEntity | null> {
    return this.db.getRepository(AiWorkspaceSetupEntity).findOne({ where: { id } })
  }

  /** 主体的默认清单（工作区没指定 `setup_id` 时用） */
  async findDefaultSetup(owner: {
    ownerType: 'user' | 'admin'
    ownerId: string
  }): Promise<AiWorkspaceSetupEntity | null> {
    return this.db.getRepository(AiWorkspaceSetupEntity).findOne({
      where: { ...owner, name: 'default' },
    })
  }

  /**
   * 可物化的技能：**按 caller 过滤后的可见集合**（§6.7.1 / §6.7.2）。
   *
   * 内置技能全员可见；平台导入 / 在线创建需显式授予；个人技能仅 owner；
   * 超管看全部平台技能；同名时个人覆盖平台（目录名相同，物化以个人内容为准）。
   */
  async listVisibleSkills(caller: {
    ownerType: 'user' | 'admin'
    ownerId: string
    adminType?: 'normal' | 'god'
  }): Promise<
    {
      key: string
      name: string
      description: string
      contentHash: string | null
      files: { path: string; content: string }[]
    }[]
  > {
    const skills = await this.db.getRepository(AiSkillEntity).find({ where: { enabled: true } })
    if (skills.length === 0) return []

    const files = await this.db.getRepository(AiSkillFileEntity).find({
      where: skills.map((skill) => ({ skillId: skill.id })),
      select: { skillId: true, path: true, content: true },
    })

    const idOf = new Map(skills.map((skill) => [skill.skillKey, skill.id]))
    const rows = await this.visibleRows(caller, skills)
    return rows.map((skill) => ({
      key: skill.key,
      name: skill.name,
      description: skill.description,
      contentHash: skill.contentHash ?? null,
      files: files
        .filter((file) => file.skillId === idOf.get(skill.key))
        .map((file) => ({ path: file.path, content: file.content })),
    }))
  }

  /**
   * 可见技能集合的版本（**只读 `content_hash`，不拉正文**）。
   *
   * 冷路径（每次 ensure 的 60s 节流比对）用它判断「.agents/ 是否落后」；
   * 拉正文是几十 KB～几 MB 的量级，不能为了一个版本号去读。
   */
  async skillSetVersionOf(caller: {
    ownerType: 'user' | 'admin'
    ownerId: string
    adminType?: 'normal' | 'god'
  }): Promise<string> {
    const skills = await this.db.getRepository(AiSkillEntity).find({
      where: { enabled: true },
      select: {
        id: true,
        skillKey: true,
        title: true,
        description: true,
        source: true,
        scope: true,
        ownerType: true,
        ownerId: true,
        contentHash: true,
      },
    })
    if (skills.length === 0) return computeSkillSetVersion([])
    return computeSkillSetVersion(await this.visibleRows(caller, skills))
  }

  /** 可见技能行（含授权过滤）；调用方决定要不要再补正文 */
  private async visibleRows(
    caller: { ownerType: 'user' | 'admin'; ownerId: string; adminType?: 'normal' | 'god' },
    skills: AiSkillEntity[],
  ): Promise<SkillRow[]> {
    const grants = await this.db.getRepository(AiSkillGrantEntity).find({
      select: { skillKey: true, principalType: true, principalId: true },
    })
    const rows: SkillRow[] = skills.map((skill) => ({
      key: skill.skillKey,
      name: skill.title || skill.skillKey,
      description: skill.description,
      source: skill.source,
      scope: skill.scope,
      ownerType: skill.ownerType,
      ownerId: skill.ownerId,
      contentHash: skill.contentHash,
      files: [],
    }))
    const grantRows: SkillGrantRow[] = grants.map((grant) => ({
      skillKey: grant.skillKey,
      principalType: grant.principalType,
      principalId: grant.principalId,
    }))
    const adminType = caller.adminType ?? (await this.adminTypeOf(caller))
    return visibleSkillsOf(rows, grantRows, { ...caller, ...(adminType ? { adminType } : {}) })
  }

  /** 超管的"全部平台技能"需要 admins.type；执行面只读这一列，不引入权限逻辑 */
  private async adminTypeOf(caller: {
    ownerType: 'user' | 'admin'
    ownerId: string
  }): Promise<'normal' | 'god' | undefined> {
    if (caller.ownerType !== 'admin') return undefined
    const row = await this.db.getRepository(AdminEntity).findOne({
      where: { id: caller.ownerId },
      select: { type: true },
    })
    return row?.type === 'god' ? 'god' : 'normal'
  }

  /** 主体名下可用凭据的版本信息（算 `credentialVersion` 用） */
  async listActiveCredentialVersions(owner: {
    ownerType: 'user' | 'admin'
    ownerId: string
  }): Promise<{ version: number }[]> {
    return this.db.getRepository(PersonalCredentialEntity).find({
      where: { ...owner, status: CredentialStatus.Active },
      select: { version: true },
    })
  }

  /** 主体名下可用的凭据名（初始化时按名解析并落地） */
  async listActiveCredentialNames(owner: {
    ownerType: 'user' | 'admin'
    ownerId: string
  }): Promise<string[]> {
    const rows = await this.db.getRepository(PersonalCredentialEntity).find({
      where: { ...owner, status: CredentialStatus.Active },
      select: { name: true },
      order: { createdAt: 'ASC' },
    })
    return rows.map((row) => row.name)
  }

  /**
   * 列出所有 container 后端的工作区 id（只取 id）。
   *
   * 回收器用它做「孤儿认领」：进程重启后内存里的 handle 没了，但容器还在跑，
   * 得从 DB 反查出候选集，再逐个探测容器是否真的在跑。
   */
  async listContainerWorkspaceIds(): Promise<{ id: string; runtime: 'docker' | 'kubernetes' }[]> {
    const rows = await this.db.getRepository(AiWorkspaceEntity).find({
      where: { backend: 'container' },
      select: { id: true, driver: true },
    })
    return rows.map((row) => ({
      id: row.id,
      runtime: row.driver === 'pod' ? 'kubernetes' : 'docker',
    }))
  }
}

/** 初始化阶段的只读查询（工作区归属 / 清单 / 技能 / 凭据名） */
export interface WorkspaceSetupContext {
  ownerType: 'user' | 'admin'
  ownerId: string
  setupId: string | null
  setupExtra: unknown[]
}
