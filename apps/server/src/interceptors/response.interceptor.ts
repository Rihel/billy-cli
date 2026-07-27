import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { ResponseUtils } from '@repo/shared';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map((data) => {
        // 如果返回值已经是 AppResponse 格式，直接返回
        if (data && typeof data === 'object' && 'code' in data) {
          return data;
        }
        return ResponseUtils.success(data);
      }),
    );
  }
}
