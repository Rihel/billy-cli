import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Inject,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppError, RequestContextService } from '@repo/kits';
import { AppErrorCodes } from '@repo/shared';
import type { Request } from 'express';
import type { ContextData } from '../infra/infra.module.js';

export interface AuthenticatedRequest extends Request {
  userId: string;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(JwtService) private jwt: JwtService,
    @Inject(RequestContextService)
    private requestContext: RequestContextService<ContextData>,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    // 优先从 Authorization header 取，其次从 cookie access-token 取
    const authHeader = req.headers.authorization;
    let rawToken: string | undefined;

    if (authHeader?.startsWith('Bearer ')) {
      rawToken = authHeader.slice(7);
    } else {
      const cookieStr = req.headers.cookie;
      if (cookieStr) {
        const cookies = this.parseCookies(cookieStr);
        rawToken = cookies['access-token'];
      }
    }

    if (!rawToken) {
      throw new AppError(AppErrorCodes.Unauthorized);
    }

    try {
      const payload = this.jwt.verify<{ sub: string }>(rawToken);
      (req as AuthenticatedRequest).userId = payload.sub;
      this.requestContext.set('userId', payload.sub);
      return true;
    } catch {
      throw new AppError(AppErrorCodes.TokenInvalid);
    }
  }

  private parseCookies(cookieStr: string): Record<string, string> {
    const result: Record<string, string> = {};
    cookieStr.split(';').forEach((cookie) => {
      const [key, ...rest] = cookie.trim().split('=');
      if (key && rest.length > 0) {
        result[key.trim()] = rest.join('=').trim();
      }
    });
    return result;
  }
}
