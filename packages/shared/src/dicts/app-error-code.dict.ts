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
  StorageKeyInvalid: {
    label: '文件 key 非法',
    value: 3201,
    http: 400,
  },
  StorageKeyForbidden: {
    label: '无权访问该文件',
    value: 3202,
    http: 403,
  },
  StorageAdminOnly: {
    label: '该存储操作仅限管理员',
    value: 3203,
    http: 403,
  },
  AgentUnavailable: {
    label: 'AI 能力未配置（缺少模型或密钥）',
    value: 3301,
    http: 503,
  },
  AgentFailed: {
    label: 'AI 回复失败，请稍后再试',
    value: 3302,
    http: 502,
  },
  AgentNotFound: {
    label: '指定的 AI 助手不存在',
    value: 3303,
    http: 404,
  },
  ConversationNotFound: {
    // 刻意不区分「不存在」与「不是你的」：避免被用来探测他人会话
    label: '会话不存在或无权访问',
    value: 3304,
    http: 404,
  },
  RunNotFound: {
    label: '运行记录不存在',
    value: 3305,
    http: 404,
  },
  ConversationBusy: {
    label: '该会话已有正在进行的对话，请稍候',
    value: 3306,
    http: 409,
  },
  ContextTooLong: {
    label: '上下文过长，请开启新会话或精简问题',
    value: 3307,
    http: 400,
  },
  ProviderAuthFailed: {
    label: '模型鉴权失败，请检查服务端模型配置',
    value: 3308,
    http: 502,
  },
  ProviderRateLimited: {
    label: '模型服务繁忙，请稍后再试',
    value: 3309,
    http: 429,
  },
  RunTimeout: {
    label: '本次对话超时，请重试',
    value: 3310,
    http: 504,
  },
  ChatAttachmentFailed: {
    label: '附件读取失败，请重新上传后再发',
    value: 3311,
    http: 400,
  },
  RunNotSuspended: {
    label: '这一轮没有在等待回答，无法续跑',
    value: 3313,
    http: 409,
  },
  ModelCapabilityMismatch: {
    label: '当前模型读不了这个附件，请换一个支持图片 / 文件的模型或去掉附件',
    value: 3312,
    http: 400,
  },
  ProviderNotFound: {
    label: '模型供应商不存在',
    value: 3401,
    http: 404,
  },
  ModelNotFound: {
    label: '模型不存在',
    value: 3402,
    http: 404,
  },
  ModelSyncFailed: {
    label: '拉取模型明细失败',
    value: 3403,
    http: 502,
  },
  ProviderDisabled: {
    label: '该模型供应商已禁用',
    value: 3404,
    http: 409,
  },
  ProviderKeyUnavailable: {
    label: '模型供应商未配置密钥，请先在后台「模型管理」补上',
    value: 3405,
    http: 409,
  },
  ModelNotConfigured: {
    label: '还没有配置可用的模型，请先在后台「模型管理」添加',
    value: 3406,
    http: 409,
  },
  ToolNotRegistered: {
    label: '工具不存在或未注册',
    value: 3407,
    http: 404,
  },
  ToolConfigInvalid: {
    label: '工具配置不合法',
    value: 3408,
    http: 400,
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
