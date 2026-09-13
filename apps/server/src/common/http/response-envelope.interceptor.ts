import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common'
import { Injectable } from '@nestjs/common'
import { ResponseUtils } from '@repo/shared'
import { map, type Observable } from 'rxjs'

/**
 * 统一响应信封拦截器：控制器只返回业务数据，这里统一包成 `{ code: 0, data }`。
 *
 * - HTTP 状态码统一由各路由的 `@HttpCode(200)` 固定（Nest 对 POST 默认 201）；
 * - 返回 undefined 的处理器（如 SSE 自行写流）不做包装。
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(
        map((data) => (data === undefined ? undefined : ResponseUtils.success(data))),
      )
  }
}
