import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common'
import { RemoveSessionSchema } from '@repo/shared'
import type { RemoveSessionDto } from '@repo/shared'
import type { Request } from 'express'
import { extractToken, requestContext } from '../../common/index.js'
import { AnyAuthGuard } from '../auth/any-auth.guard.js'
import { SessionService, type SessionIdentity } from './session.service.js'

/**
 * 登录设备（会话）路由：`POST /session/list` + `POST /session/remove`。
 *
 * - 鉴权：`AnyAuthGuard`（前台用户或后台管理员），一套实现同时服务两套身份体系；
 * - 作用域：身份从请求上下文 ALS 取，**管理员优先**（管理员 token 不会同时带 userId）；
 * - 「当前会话」判定：把请求自带 token 交给 service 与会话条目比对（JWT 里没有 sessionId，
 *   也不为此改 token 结构）。
 */
@Controller('session')
@UseGuards(AnyAuthGuard)
export class SessionController {
  constructor(@Inject(SessionService) private readonly sessionService: SessionService) {}

  private identity(): SessionIdentity | null {
    const adminId = requestContext.get('adminId')
    if (adminId) return { type: 'admin', sub: adminId }

    const userId = requestContext.get('userId')
    if (userId) return { type: 'user', sub: userId }

    // 鉴权关闭（AUTH_ENABLED=false）：守卫放行但无身份，service 按「无会话」处理
    return null
  }

  @Post('list')
  @HttpCode(200)
  list(@Req() request: Request) {
    return this.sessionService.list(this.identity(), extractToken(request))
  }

  @Post('remove')
  @HttpCode(200)
  remove(@Body({ schema: RemoveSessionSchema }) input: RemoveSessionDto) {
    return this.sessionService.remove(this.identity(), input.sessionId)
  }
}
