import {
  Catch,
  HttpException,
  Inject,
  Optional,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import { ResponseUtils } from '@repo/shared'
import type { Request, Response } from 'express'
import { BoundaryError } from './boundary-error.js'
import { ERROR_ALERT_HOOK, type ErrorAlertHook } from './error-alert-hook.js'
import { mapError } from './error-descriptor.js'
import { requestContext } from '../request-context/request-context.js'
import { ZodValidationFailedError } from '../http/zod-validation.js'

/**
 * 全局异常过滤器（统一的错误映射 + 404 + 校验失败响应）：
 * - Zod 校验失败 → **HTTP 200** + `{ code: 400, message }`（历史格式）；
 * - 边界错误（守卫 / 限流）→ 携带的 HTTP 状态 + 可选响应头 + AppResponse 信封；
 * - 业务 / 基础设施错误（AppError.code）→ 查字典映射 HTTP + 中文文案；
 * - Nest 路由未命中 → HTTP 404 `{ code: 404, message: '接口不存在' }`；
 * - 未知错误 → HTTP 500 `{ code: 5001, message: '系统错误' }`。
 *
 * 仅「非边界错误」触发技术告警（与历史行为一致：校验失败 / 未认证 / 限流不算技术故障）。
 */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  constructor(
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(ERROR_ALERT_HOOK)
    @Optional()
    private readonly alertHook?: ErrorAlertHook,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp()
    const response = context.getResponse<Response>()
    const request = context.getRequest<Request>()

    // 预期内的边界结果：不记错误日志、不触发告警
    if (exception instanceof ZodValidationFailedError) {
      response.status(200).json(ResponseUtils.error(400, exception.detail))
      return
    }
    if (exception instanceof BoundaryError) {
      for (const [name, value] of Object.entries(exception.headers)) {
        response.setHeader(name, value)
      }
      response.status(exception.http).json(ResponseUtils.error(exception.value, exception.label))
      return
    }
    // 框架层 HttpException（路由未命中 404 / 请求体解析失败 400）：边界预期结果，
    // 不记错误日志、不触发告警
    if (exception instanceof HttpException) {
      const frameworkError = mapError(exception)
      response
        .status(frameworkError.http)
        .json(ResponseUtils.error(frameworkError.value, frameworkError.label))
      return
    }

    const descriptor = mapError(exception)
    this.logger.error('请求处理失败', { error: exception })

    // 告警接入：技术错误异步通知（fire-and-forget，失败不影响错误响应）
    try {
      this.alertHook?.(exception, {
        path: request.path,
        requestId: requestContext.get('requestId'),
      })
    } catch {
      // 告警链路异常不影响返回
    }

    // 响应头已发出（典型：SSE 长连接写头之后才抛错）：已无法改写状态码与 body，
    // 再调 response.json 会抛 ERR_HTTP_HEADERS_SENT —— 那会把异常过滤器自己也炸掉、
    // 连接被硬断且日志里只剩「二次故障」。这里直接结束响应，保留首因日志。
    if (response.headersSent) {
      if (!response.writableEnded) response.end()
      return
    }

    response.status(descriptor.http).json(ResponseUtils.error(descriptor.value, descriptor.label))
  }
}
