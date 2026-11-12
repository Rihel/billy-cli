import { Body, Controller, Headers, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import {
  CreateShareSchema,
  ListShareSchema,
  RevokeShareSchema,
  ShareTokenSchema,
} from '@repo/shared'
import type {
  CreateShareDto,
  ListShareDto,
  RevokeShareDto,
  ShareTokenDto,
} from '@repo/shared'
import { AnyAuthGuard } from '../auth/any-auth.guard.js'
import { RateLimit, RateLimitGuard, requestContext } from '../../common/index.js'
import { ShareService, type ShareIdentity } from './share.service.js'

/**
 * 文件分享路由（`/share/*`，设计 `docs/design/file-share.md` §5）。
 *
 * 三组接口、两种鉴权姿态：
 * - `create` / `list` / `revoke`：`AnyAuthGuard`（管理员或文件归属者），给后台文件页用；
 * - `meta`：**公开**（分享页服务端渲染时调用），只靠 token + 限流；
 * - `resolve`：**内部**（只有 Next 的 content 路由调），靠 `x-share-internal` 密钥。
 *
 * 全部 POST + `@HttpCode(200)`（本工程业务路由约定）。
 */
@Controller('share')
export class ShareController {
  constructor(@Inject(ShareService) private readonly shareService: ShareService) {}

  /**
   * 当前身份。
   *
   * 与 storage 控制器同一写法：直接读 ALS 而不用 `currentUserId()` ——
   * 双身份模式下必然有一个缺失，鉴权关闭时两个都没有。
   */
  private identity(): ShareIdentity {
    return {
      adminId: requestContext.get('adminId') ?? undefined,
      userId: requestContext.get('userId') ?? undefined,
    }
  }

  @Post('create')
  @HttpCode(200)
  @UseGuards(AnyAuthGuard)
  create(@Body({ schema: CreateShareSchema }) input: CreateShareDto) {
    return this.shareService.create(this.identity(), input)
  }

  @Post('list')
  @HttpCode(200)
  @UseGuards(AnyAuthGuard)
  list(@Body({ schema: ListShareSchema }) input: ListShareDto) {
    return this.shareService.list(this.identity(), input)
  }

  @Post('revoke')
  @HttpCode(200)
  @UseGuards(AnyAuthGuard)
  revoke(@Body({ schema: RevokeShareSchema }) input: RevokeShareDto) {
    return this.shareService.revoke(this.identity(), input.id)
  }

  @Post('meta')
  @HttpCode(200)
  @RateLimit({ scope: 'share-meta', limit: 60 })
  @UseGuards(RateLimitGuard)
  meta(@Body({ schema: ShareTokenSchema }) input: ShareTokenDto) {
    return this.shareService.meta(input)
  }

  @Post('resolve')
  @HttpCode(200)
  resolve(
    @Headers('x-share-internal') secret: string | undefined,
    @Body({ schema: ShareTokenSchema }) input: ShareTokenDto,
  ) {
    return this.shareService.resolve(input, secret)
  }
}
