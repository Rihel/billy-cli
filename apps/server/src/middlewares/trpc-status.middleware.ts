import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

/** tRPC 错误响应体结构（简化） */
interface TrpcErrorBody {
  error?: {
    data?: {
      errorCode?: number;
    };
  };
}

/**
 * 规范 tRPC 路由的 HTTP 状态码：
 *   - 认证/权限类错误（errorCode 1xxx）→ 保持 4xx
 *   - 业务类错误（errorCode 2xxx、3xxx）→ 改为 200
 *   - 无 errorCode（框架级错误，如未登录中间件）→ 保持原状
 *   - 5xx 系统错误 → 保持原状
 */
@Injectable()
export class TrpcStatusMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const originalJson = res.json.bind(res);

    res.json = function (body: unknown) {
      if (res.statusCode >= 400 && res.statusCode < 500) {
        const errorCode = (body as TrpcErrorBody)?.error?.data?.errorCode;
        // 有明确的业务码且不在 1xxx 认证段 → 统一返回 200
        if (errorCode != null && errorCode >= 2000) {
          res.statusCode = 200;
        }
      }
      return originalJson(body);
    } as typeof res.json;

    next();
  }
}
