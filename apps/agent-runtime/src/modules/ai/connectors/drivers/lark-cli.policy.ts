import { z } from 'zod'
import { ToolDeniedError } from '../../core/tools/tools.types.js'

/**
 * **lark-cli 的受限命令面**（设计 `docs/design/ai-connector.md` §3.14）。
 *
 * 这里是连接器的安全边界：只允许"业务域 + 只读辅助命令"，不放管理类命令
 * （`config` / `profile` / `update` / `auth logout`），也不放能绕过业务边界的
 * `api`（任意 OpenAPI 路径）与长驻的 `event`（WebSocket 订阅）。
 *
 * 白名单写死在代码里、页面改不了——管理员能改的只有"连哪个应用、授权给谁"，
 * 不能把连接器变成任意命令执行。
 */

/** 与 `lark-cli --help` 的 Lark domains 对齐；去掉 `application` / `apps` / `event` */
export const LARK_CLI_DOMAINS = [
  'approval',
  'attendance',
  'base',
  'calendar',
  'contact',
  'docs',
  'drive',
  'im',
  'mail',
  'markdown',
  'mindnotes',
  'minutes',
  'note',
  'okr',
  'sheets',
  'slides',
  'task',
  'vc',
  'whiteboard',
  'wiki',
] as const

/** 只读辅助：查接口定义 / 查当前身份 */
const LARK_CLI_HELPERS = ['schema', 'whoami'] as const

/** 技能文档是 CLI 内嵌的，只允许读 */
const LARK_CLI_SKILLS = ['list', 'read'] as const

/** 授权类只放"看状态"和"发起登录"；`logout` 会清掉管理员刚做好的授权 */
const LARK_CLI_AUTH = ['status', 'list', 'login', 'scopes', 'check'] as const

const DOMAIN_SET = new Set<string>(LARK_CLI_DOMAINS)
const SKILLS_SET = new Set<string>(LARK_CLI_SKILLS)
const AUTH_SET = new Set<string>(LARK_CLI_AUTH)

/** 一次调用的参数上限（与工具入参 schema 同口径） */
export const LARK_CLI_MAX_ARGS = 32
export const LARK_CLI_MAX_ARG_LENGTH = 2_048

const ArgsSchema = z.object({
  args: z.array(z.string().min(1).max(LARK_CLI_MAX_ARG_LENGTH)).min(1).max(LARK_CLI_MAX_ARGS),
})

/** 允许告诉模型/页面的命令面（错误提示里用，别让模型瞎猜） */
export const LARK_CLI_ALLOWED_SUMMARY = [
  ...LARK_CLI_DOMAINS,
  ...LARK_CLI_HELPERS,
  'skills list|read',
  'auth status|list|login|scopes|check',
].join(' / ')

const deny = (message: string, hint?: string): never => {
  throw new ToolDeniedError('invalid-input', message, hint)
}

/**
 * 校验并归一模型给的参数数组。
 *
 * **纯函数**：不碰进程、不读配置，单测直接覆盖；驱动拿到的就是校验过的数组。
 *
 * 三道闸：
 * 1. 形状（1~32 个非空字符串）；
 * 2. 控制字符与 `--profile` / `--yes`（前者换身份，后者会跳过高风险确认）；
 * 3. 第一段必须是业务域 / 辅助命令，`auth` 与 `skills` 还要再查子命令。
 */
export const parseLarkCliArgs = (input: unknown): string[] => {
  const parsed = ArgsSchema.safeParse(input)
  if (!parsed.success) {
    throw new ToolDeniedError(
      'invalid-input',
      `args 必须是 1~${LARK_CLI_MAX_ARGS} 个非空字符串（子命令 + 参数）`,
      `例如 ["skills","list"] 或 ["im","+messages-send","--chat-id","oc_xxx","--text","你好"]`,
    )
  }
  const args = parsed.data.args

  for (const arg of args) {
    // 校验目的就是拦截控制字符（终端注入 / 日志污染），这里的匹配范围是该规则的唯一正确写法
    // oxlint-disable-next-line eslint/no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(arg)) {
      deny('参数里不允许控制字符')
    }
    if (arg === '--profile' || arg.startsWith('--profile=')) {
      deny('不允许切换 profile', '连接器的身份由实例配置决定，换 profile 会绕过隔离')
    }
    if (arg === '--yes') {
      deny('不允许带 --yes', '高风险写操作需要人在终端确认，不能由模型直接跳过')
    }
  }

  const [command, sub] = args

  if (DOMAIN_SET.has(command)) {
    return args
  }

  if (command === 'schema') {
    if (args.length < 2) {
      deny(
        'schema 必须带方法名',
        '例如 ["schema","im.messages.create"]；不带方法名会返回约 1.5MB 的全量接口清单',
      )
    }
    return args
  }

  if (command === 'whoami') {
    return args
  }

  if (command === 'skills') {
    if (!sub || !SKILLS_SET.has(sub)) {
      deny(`skills 只允许 list / read，收到：${sub ?? '（空）'}`, '例如 ["skills","list"]')
    }
    if (sub === 'read' && args.length < 3) {
      deny('skills read 必须带技能名', '例如 ["skills","read","lark-im"]')
    }
    return args
  }

  if (command === 'auth') {
    if (!sub || !AUTH_SET.has(sub)) {
      deny(
        `auth 只允许 ${LARK_CLI_AUTH.join(' / ')}，收到：${sub ?? '（空）'}`,
        '不要在连接器里登出（auth logout），需要时由管理员在服务器上处理',
      )
    }
    // login 默认会阻塞等浏览器；只放行 agent 模式的两种非阻塞形态
    if (sub === 'login' && !args.includes('--no-wait') && !args.includes('--device-code')) {
      deny(
        'auth login 不带 --no-wait 会一直阻塞到授权完成',
        '先用 ["auth","login","--no-wait","--json"] 拿验证链接，用户完成后用 ["auth","login","--device-code","<code>"] 收尾',
      )
    }
    return args
  }

  return deny(`不允许的命令：${command}`, `只允许：${LARK_CLI_ALLOWED_SUMMARY}`)
}

/** 是否是业务域（默认身份只对业务命令追加 `--as`） */
export const isLarkCliDomain = (command: string | undefined): boolean =>
  Boolean(command && DOMAIN_SET.has(command))
