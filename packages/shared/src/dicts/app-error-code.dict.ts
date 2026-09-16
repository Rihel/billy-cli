import { createDict } from '../utils/dict.utils'

export const AppErrorCodes = createDict({
  EmailNotFound: {
    label: '邮箱不存在',
    value: 1000,
    http: 404,
  },
  EmailTaken: {
    label: '邮箱已经被注册',
    value: 1001,
    http: 409,
  },
  InvalidCredentials: {
    label: '邮箱或密码错误',
    value: 1002,
    http: 401,
  },
  InvalidResetToken: {
    label: '无效的重置令牌',
    value: 1003,
    http: 400,
  },
  ExpiredResetToken: {
    label: '重置令牌已过期',
    value: 1004,
    http: 400,
  },
  TokenInvalid: {
    label: 'Token 无效或已过期',
    value: 1005,
    http: 401,
  },
  Unauthorized: {
    label: '请先登录',
    value: 1006,
    http: 401,
  },
  InvalidOldPassword: {
    label: '旧密码错误',
    value: 1008,
    http: 400,
  },
  PasswordUnchanged: {
    label: '新密码不能与旧密码相同',
    value: 1009,
    http: 400,
  },
  Forbidden: {
    label: '权限不足',
    value: 1007,
    http: 403,
  },
  UserNotFound: {
    label: '用户不存在',
    value: 2001,
    http: 404,
  },
  AdminNotFound: {
    label: '管理员不存在',
    value: 2002,
    http: 404,
  },
  AdminEmailTaken: {
    label: '管理员邮箱已被使用',
    value: 2003,
    http: 409,
  },
  AdminDisabled: {
    label: '管理员已被禁用',
    value: 2004,
    http: 403,
  },
  InvalidAdminCredentials: {
    label: '邮箱或密码错误',
    value: 2005,
    http: 401,
  },
  CannotRemoveSelf: {
    label: '不能删除当前登录账号',
    value: 2006,
    http: 400,
  },
  UserDisabled: {
    label: '用户已被禁用',
    value: 2007,
    http: 403,
  },
  TodoNotFound: {
    label: 'Todo 不存在',
    value: 3001,
    http: 404,
  },
  AlertRuleNotFound: {
    label: '告警规则不存在',
    value: 3101,
    http: 404,
  },
  AlertRuleNameTaken: {
    label: '告警规则名称已存在',
    value: 3102,
    http: 409,
  },
  InvalidInput: {
    label: '参数校验失败',
    value: 4001,
    http: 400,
  },
  RateLimited: {
    label: '请求过于频繁，请稍后再试',
    value: 4002,
    http: 429,
  },
  Internal: {
    label: '系统错误',
    value: 5001,
    http: 500,
  },
  NotReady: {
    label: '服务未就绪',
    value: 5002,
    http: 503,
  },
})
