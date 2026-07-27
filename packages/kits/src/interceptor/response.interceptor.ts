import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common'
import { Observable, map } from 'rxjs'
import { AppLoggerService } from '../logger/logger.service.js'
import { ResponseUtils } from '@repo/shared'

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  constructor(private readonly logger: AppLoggerService) {
    this.logger.setContext(ResponseInterceptor.name)
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const handlerName = context.getHandler().name
    const controllerName = context.getClass().name

    return next.handle().pipe(
      map((data) => {
        const response = context.switchToHttp().getResponse<any>()

        // NestJS POST 默认返回 201，改为 200
        response.status(200)

        this.logger.info('响应成功', { controller: controllerName, handler: handlerName })

        // 如果返回值已经是 AppResponse 格式，直接返回
        if (data && typeof data === 'object' && 'code' in data) {
          return data
        }
        return ResponseUtils.success(data)
      }),
    )
  }
}
