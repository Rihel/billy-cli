import { TRPCError } from '@trpc/server';
import type { TRPC_ERROR_CODE_KEY } from '@trpc/server/rpc';

type HttpStatus = 400 | 401 | 403 | 404 | 409 | 500;

interface ErrorDef {
  /** 对外暴露的数字业务码 */
  code: number;
  trpc: TRPC_ERROR_CODE_KEY;
  http: HttpStatus;
  message: string;
}

/**
 * 业务错误码注册表
 *
 * 数字分段规则：
 *   1xxx — 认证 / 权限
 *   2xxx — 用户业务
 *   3xxx — Todo 业务
 *   5xxx — 系统 / 未知
 */
export const ERROR_CODES = {
  // ── 1xxx 认证 ─────────────────────────────────────────
  EMAIL_TAKEN: {
    code: 1001,
    trpc: 'CONFLICT',
    http: 409,
    message: '该邮箱已被注册',
  },
  INVALID_CREDENTIALS: {
    code: 1002,
    trpc: 'UNAUTHORIZED',
    http: 401,
    message: '邮箱或密码错误',
  },
  INVALID_RESET_TOKEN: {
    code: 1003,
    trpc: 'BAD_REQUEST',
    http: 400,
    message: '无效的重置令牌',
  },
  EXPIRED_RESET_TOKEN: {
    code: 1004,
    trpc: 'BAD_REQUEST',
    http: 400,
    message: '重置令牌已过期',
  },
  TOKEN_INVALID: {
    code: 1005,
    trpc: 'UNAUTHORIZED',
    http: 401,
    message: 'Token 无效或已过期',
  },
  UNAUTHORIZED: {
    code: 1006,
    trpc: 'UNAUTHORIZED',
    http: 401,
    message: '请先登录',
  },
  FORBIDDEN: { code: 1007, trpc: 'FORBIDDEN', http: 403, message: '权限不足' },
  // ── 2xxx 用户 ─────────────────────────────────────────
  USER_NOT_FOUND: {
    code: 2001,
    trpc: 'NOT_FOUND',
    http: 404,
    message: '用户不存在',
  },
  // ── 3xxx Todo ─────────────────────────────────────────
  TODO_NOT_FOUND: {
    code: 3001,
    trpc: 'NOT_FOUND',
    http: 404,
    message: 'Todo 不存在',
  },
  // ── 5xxx 系统 ─────────────────────────────────────────
  INTERNAL: {
    code: 5001,
    trpc: 'INTERNAL_SERVER_ERROR',
    http: 500,
    message: '服务器内部错误',
  },
} as const satisfies Record<string, ErrorDef>;

export type AppErrorCode = keyof typeof ERROR_CODES;

/**
 * 传输无关的业务异常。
 *
 * - **tRPC**：`AppError extends TRPCError`，tRPC 原生识别，无需任何适配层。
 * - **REST**：在 ExceptionFilter 中 catch `AppError`，使用 `httpStatus` / `errorCode` 返回响应：
 *   ```ts
 *   @Catch(AppError)
 *   export class AppErrorFilter implements ExceptionFilter {
 *     catch(err: AppError, host: ArgumentsHost) {
 *       host.switchToHttp().getResponse()
 *         .status(err.httpStatus)
 *         .json({ code: err.errorCode, message: err.message });
 *     }
 *   }
 *   ```
 */
export class AppError extends TRPCError {
  /** 数字业务码，对外暴露给客户端 */
  public readonly errorCode: number;
  /** HTTP 状态码，供 REST 传输层使用 */
  public readonly httpStatus: HttpStatus;

  constructor(code: AppErrorCode, message?: string) {
    const def = ERROR_CODES[code];
    super({ code: def.trpc, message: message ?? def.message });
    this.errorCode = def.code;
    this.httpStatus = def.http;
    this.name = 'AppError';
  }
}

/** 业务异常工厂快捷方式 */
export const AppErrors = {
  emailTaken: () => new AppError('EMAIL_TAKEN'),
  invalidCredentials: () => new AppError('INVALID_CREDENTIALS'),
  invalidResetToken: () => new AppError('INVALID_RESET_TOKEN'),
  expiredResetToken: () => new AppError('EXPIRED_RESET_TOKEN'),
  tokenInvalid: () => new AppError('TOKEN_INVALID'),
  unauthorized: (msg?: string) => new AppError('UNAUTHORIZED', msg),
  forbidden: (msg?: string) => new AppError('FORBIDDEN', msg),
  userNotFound: () => new AppError('USER_NOT_FOUND'),
  todoNotFound: () => new AppError('TODO_NOT_FOUND'),
  notFound: (resource: string) =>
    new AppError('USER_NOT_FOUND', `${resource}不存在`),
  internal: (msg?: string) => new AppError('INTERNAL', msg),
} as const;
