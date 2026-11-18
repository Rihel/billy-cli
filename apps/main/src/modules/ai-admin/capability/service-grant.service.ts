import { BadRequestException, Inject, Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { Db } from '@repo/kits'
import { AdminEntity, AiServiceGrantEntity } from '@repo/db'
import type { ServiceGrantModel, ServiceGrantSetDto } from '@repo/shared'
import { CapabilityServiceAdminService } from './capability.service.js'

const toModel = (row: AiServiceGrantEntity): ServiceGrantModel => ({
  id: row.id,
  principalType: row.principalType as 'admin',
  principalId: row.principalId,
  service: row.service,
  grantedBy: row.grantedBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

/**
 * 服务级授权（管理员 × 外部服务/MCP）。
 *
 * 只对 `source='manual'` 生效；`source='code'` 的自建协议服务默认全部可用，拒绝写入授权表。
 * 任何管理员都能改（当前口径；后续做角色/策略时再收紧）。
 */
@Injectable()
export class ServiceGrantAdminService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(CapabilityServiceAdminService)
    private readonly capabilities: CapabilityServiceAdminService,
  ) {}

  /** 登记新 manual 服务后自动授权给登记人（已存在则 no-op） */
  async ensureGrant(adminId: string, service: string): Promise<void> {
    const repo = this.db.getRepository(AiServiceGrantEntity)
    const existing = await repo.findOne({
      where: { principalType: 'admin', principalId: adminId, service },
    })
    if (existing) return
    await repo.insert({
      id: randomUUID().replace(/-/g, '').slice(0, 20),
      principalType: 'admin',
      principalId: adminId,
      service,
      grantedBy: adminId,
    })
  }

  async list(): Promise<ServiceGrantModel[]> {
    const rows = await this.db.getRepository(AiServiceGrantEntity).find({
      order: { service: 'ASC', principalId: 'ASC' },
    })
    return rows.map(toModel)
  }

  async set(input: ServiceGrantSetDto): Promise<ServiceGrantModel[]> {
    const admin = await this.db.getRepository(AdminEntity).findOne({ where: { id: input.adminId } })
    if (!admin) throw new BadRequestException('管理员不存在')

    const services = await this.capabilities.list({})
    const manual = new Set(
      services.filter((service) => service.source === 'manual').map((service) => service.service),
    )
    const invalid = input.services.filter((service) => !manual.has(service))
    if (invalid.length > 0) {
      throw new BadRequestException(
        `只有外部服务/MCP 需要授权：${invalid.join('、')}（自建协议服务默认全部可用）`,
      )
    }

    const repo = this.db.getRepository(AiServiceGrantEntity)
    await repo.delete({ principalType: 'admin', principalId: input.adminId })
    if (input.services.length > 0) {
      await repo.insert(
        [...new Set(input.services)].map((service) => ({
          id: randomUUID().replace(/-/g, '').slice(0, 20),
          principalType: 'admin',
          principalId: input.adminId,
          service,
          grantedBy: null,
        })),
      )
    }
    return this.list()
  }
}
