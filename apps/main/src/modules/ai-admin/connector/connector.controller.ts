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

/**
 * 连接器管理路由（`/ai-connector/*`，**全部后台管理员鉴权** + 全部 POST）。
 *
 * 路径与入参 schema 保持与迁移前一致（前端 `/main/ai/connectors` 不用改）：
 * `catalog` / `list` / `create` / `update` / `detail` / `test` / `sync` / `remove`。
 *
 * 只做 HTTP 边界：入参经 `@Body({ schema })` 校验后交给 service；不碰驱动、不碰注册机。
 *
 * 两条边界（与 runtime 分工，见 service 注释）：
 * - `test` 只测连接配置，不注册工具；
 * - `sync` 是**异步**的：main 发事件，agent-runtime 的 `ConnectorSyncService` 真正同步。
 */
@Controller('ai-connector')
@UseGuards(AdminAuthGuard)
export class AiConnectorAdminController {
  constructor(@Inject(ConnectorService) private readonly connectors: ConnectorService) {}

  /** 型号目录（代码声明：卡片与表单都由它渲染） */
  @Post('catalog')
  @HttpCode(200)
  catalog() {
    return this.connectors.catalog()
  }

  /** 列表（分页 + 关键字 / 启停筛选） */
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

  /** 同步：发事件给 agent-runtime，由它连远端 / 写工具行 / 注册动态工具 */
  @Post('sync')
  @HttpCode(200)
  sync(@Body({ schema: AiConnectorIdSchema }) input: AiConnectorIdDto) {
    return this.connectors.sync(input.id)
  }

  /** 删除（软删；工具行保留但全部停用，并通知 runtime 摘掉动态注册） */
  @Post('remove')
  @HttpCode(200)
  async remove(@Body({ schema: AiConnectorIdSchema }) input: AiConnectorIdDto) {
    await this.connectors.remove(input.id)
    return { ok: true }
  }
}
