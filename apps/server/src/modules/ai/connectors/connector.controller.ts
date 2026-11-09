import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import {
  AiConnectorCreateSchema,
  AiConnectorIdSchema,
  AiConnectorListSchema,
  AiConnectorUpdateSchema,
} from '@repo/shared'
import type {
  AiConnectorCreateDto,
  AiConnectorIdDto,
  AiConnectorListDto,
  AiConnectorUpdateDto,
} from '@repo/shared'
import { AdminAuthGuard } from '../../admin/admin-auth.guard.js'
import { ConnectorService } from './connector.service.js'
import { ConnectorSyncService } from './connector.sync.service.js'

/**
 * 连接器路由（`/ai-connector/*`，**全部后台管理员鉴权** + 全部 POST）。
 *
 * 只做 HTTP 边界：入参经 `@Body({ schema })` 校验后交给 service。
 *
 * 两条与工具路由的分工：
 * - 这里管**实例**（地址 / 凭证 / 启停 / 同步）；
 * - 工具的开关、限额、作用域仍在 `/ai-tool/*`（治理粒度是工具行，见设计 §3.2）。
 */
@Controller('ai-connector')
@UseGuards(AdminAuthGuard)
export class AiConnectorController {
  constructor(
    @Inject(ConnectorService) private readonly connectors: ConnectorService,
    @Inject(ConnectorSyncService) private readonly sync: ConnectorSyncService,
  ) {}

  /** 型号目录（代码声明：卡片与表单都由它渲染） */
  @Post('catalog')
  @HttpCode(200)
  catalog() {
    return this.connectors.catalog()
  }

  /** 列表 */
  @Post('list')
  @HttpCode(200)
  list(@Body({ schema: AiConnectorListSchema }) input: AiConnectorListDto) {
    return this.connectors.list(input)
  }

  /** 新建实例 */
  @Post('create')
  @HttpCode(200)
  create(@Body({ schema: AiConnectorCreateSchema }) input: AiConnectorCreateDto) {
    return this.connectors.create(input)
  }

  /** 更新（省略的字段 = 不改；密钥给空串 = 清空） */
  @Post('update')
  @HttpCode(200)
  update(@Body({ schema: AiConnectorUpdateSchema }) input: AiConnectorUpdateDto) {
    return this.connectors.update(input)
  }

  /** 详情（含它产出的工具清单） */
  @Post('detail')
  @HttpCode(200)
  detail(@Body({ schema: AiConnectorIdSchema }) input: AiConnectorIdDto) {
    return this.connectors.detail(input.id)
  }

  /** 测试连接（只写状态，不动工具） */
  @Post('test')
  @HttpCode(200)
  test(@Body({ schema: AiConnectorIdSchema }) input: AiConnectorIdDto) {
    return this.connectors.test(input.id)
  }

  /** 同步：列能力 → 写工具 → 注册进注册机 */
  @Post('sync')
  @HttpCode(200)
  syncTools(@Body({ schema: AiConnectorIdSchema }) input: AiConnectorIdDto) {
    return this.sync.sync(input.id)
  }

  /** 删除（软删；工具行保留，全部停用） */
  @Post('remove')
  @HttpCode(200)
  async remove(@Body({ schema: AiConnectorIdSchema }) input: AiConnectorIdDto) {
    this.sync.disable(input.id)
    await this.connectors.remove(input.id)
    return { ok: true }
  }
}
