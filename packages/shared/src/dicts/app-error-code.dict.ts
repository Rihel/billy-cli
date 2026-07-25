import { createDict } from '../utils/dict.utils'

export const AppErrorCodes = createDict({
  EmailNotFound: {
    label: '邮箱不存在',
    value: 1000,
    http: 404,
    trpc: 'NOT_FOUND',
  },
  EmailTaken: {
    label: '邮箱已经被注册',
    value: 1001,
    http: 409,
    trpc: 'CONFLICT',
  },
  InvalidCredentials: {
    label: '邮箱或密码错误',
    value: 1002,
    http: 401,
    trpc: 'UNAUTHORIZED',
  },
  InvalidResetToken: {
    label: '无效的重置令牌',
    value: 1003,
    http: 400,
    trpc: 'BAD_REQUEST',
  },
  ExpiredResetToken: {
    label: '重置令牌已过期',
    value: 1004,
    http: 400,
    trpc: 'BAD_REQUEST',
  },
  TokenInvalid: {
    label: 'Token 无效或已过期',
    value: 1005,
    http: 401,
    trpc: 'UNAUTHORIZED',
  },
  Unauthorized: {
    label: '请先登录',
    value: 1006,
    http: 401,
    trpc: 'UNAUTHORIZED',
  },
  InvalidOldPassword: {
    label: '旧密码错误',
    value: 1008,
    http: 400,
    trpc: 'BAD_REQUEST',
  },
  PasswordUnchanged: {
    label: '新密码不能与旧密码相同',
    value: 1009,
    http: 400,
    trpc: 'BAD_REQUEST',
  },
  Forbidden: {
    label: '权限不足',
    value: 1007,
    http: 403,
    trpc: 'FORBIDDEN',
  },
  UserNotFound: {
    label: '用户不存在',
    value: 2001,
    http: 200,
    trpc: 'NOT_FOUND',
  },
  TodoNotFound: {
    label: 'Todo 不存在',
    value: 3001,
    http: 200,
    trpc: 'NOT_FOUND',
  },
  Internal: {
    label: '系统错误',
    value: 5001,
    http: 500,
    trpc: 'INTERNAL_SERVER_ERROR',
  },
})
