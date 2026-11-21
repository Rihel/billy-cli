import type { CredentialTemplate } from './credential-template.types'

/**
 * v1 首批字段模板（`docs/design/workspace-cli-credentials.md` §6.4.1.1 / Q1）。
 *
 * 五个 provider 覆盖四类资源：云厂商 AK-SK（`tencent-cloud`）、数据库（`mysql` / `redis`）、
 * 生态 CLI（`lark` / `github`）。**加一种资源只加一份模板**，不改表、不加枚举。
 *
 * 注入规则的口径（§6.4.3）：以文件为主、环境变量为辅，由工具自身决定读哪里。
 * 模板里的 `${config.x}` / `${secret.x}` 是字段路径引用，由初始化阶段渲染。
 */
const TEMPLATES: CredentialTemplate[] = [
  {
    provider: 'tencent-cloud',
    kind: 'static',
    label: '腾讯云 AK/SK',
    description: '腾讯云 API 密钥（SecretId / SecretKey），用于 CLS 等云服务',
    fields: [
      {
        key: 'region',
        label: '地域',
        type: 'text',
        scope: 'config',
        required: true,
        default: 'ap-guangzhou',
        placeholder: 'ap-guangzhou',
      },
      {
        key: 'secretId',
        label: 'SecretId',
        type: 'password',
        scope: 'secret',
        required: true,
        placeholder: 'AKID…',
      },
      {
        key: 'secretKey',
        label: 'SecretKey',
        type: 'password',
        scope: 'secret',
        required: true,
      },
    ],
    // 云厂商的提示取密钥尾部：`AKID…abcd`
    hintField: 'secretId',
    hintMode: 'tail',
    inject: [
      { type: 'env', name: 'TENCENTCLOUD_SECRET_ID', field: 'secretId' },
      { type: 'env', name: 'TENCENTCLOUD_SECRET_KEY', field: 'secretKey' },
      { type: 'env', name: 'TENCENTCLOUD_REGION', field: 'region' },
    ],
  },
  {
    provider: 'mysql',
    kind: 'static',
    label: 'MySQL 数据库',
    description: 'MySQL 连接信息；容器内的 mysql 客户端直接使用注入的口令',
    fields: [
      { key: 'host', label: '主机', type: 'text', scope: 'config', required: true },
      {
        key: 'port',
        label: '端口',
        type: 'number',
        scope: 'config',
        required: true,
        default: 3306,
      },
      { key: 'database', label: '库名', type: 'text', scope: 'config', required: true },
      { key: 'username', label: '用户名', type: 'text', scope: 'config', required: true },
      { key: 'password', label: '密码', type: 'password', scope: 'secret', required: true },
    ],
    // 数据库取用户名做提示（`root` 比 `****` 更能让人认出是哪一套库）
    hintField: 'username',
    hintMode: 'plain',
    inject: [
      {
        type: 'file',
        path: '~/.my.cnf',
        template:
          '[client]\nhost=${config.host}\nport=${config.port}\nuser=${config.username}\npassword=${secret.password}\n',
      },
    ],
  },
  {
    provider: 'redis',
    kind: 'static',
    label: 'Redis',
    description: 'Redis 连接信息；口令通过 REDISCLI_AUTH 注入，redis-cli 直接可用',
    fields: [
      { key: 'host', label: '主机', type: 'text', scope: 'config', required: true },
      {
        key: 'port',
        label: '端口',
        type: 'number',
        scope: 'config',
        required: true,
        default: 6379,
      },
      { key: 'db', label: '库号', type: 'number', scope: 'config', required: true, default: 0 },
      { key: 'username', label: '用户名（ACL）', type: 'text', scope: 'config' },
      {
        key: 'password',
        label: '密码',
        type: 'password',
        scope: 'secret',
        hint: '无密码的实例可以留空',
      },
    ],
    hintField: 'host',
    hintMode: 'plain',
    inject: [{ type: 'env', name: 'REDISCLI_AUTH', field: 'password' }],
  },
  {
    provider: 'github',
    kind: 'static',
    label: 'GitHub',
    description: 'GitHub 个人访问令牌；写入 gh 的 hosts.yml 并同时提供 GH_TOKEN',
    fields: [
      { key: 'token', label: 'Token', type: 'password', scope: 'secret', required: true },
      {
        key: 'host',
        label: '主机',
        type: 'text',
        scope: 'config',
        required: true,
        default: 'github.com',
      },
      { key: 'user', label: '用户名', type: 'text', scope: 'config' },
    ],
    hintField: 'token',
    hintMode: 'tail',
    inject: [
      {
        type: 'file',
        path: '~/.config/gh/hosts.yml',
        template:
          '${config.host}:\n    oauth_token: ${secret.token}\n    user: ${config.user}\n    git_protocol: https\n',
      },
      { type: 'env', name: 'GH_TOKEN', field: 'token' },
    ],
  },
  {
    provider: 'lark',
    kind: 'oauth',
    label: '飞书（Lark）',
    description: '飞书 OAuth 授权（access / refresh token）；由平台续期，CLI 初始化时落地',
    // oauth 的字段固定：刷新逻辑依赖这四个（§6.4.1.1）
    fields: [
      {
        key: 'accessToken',
        label: 'Access Token',
        type: 'password',
        scope: 'secret',
        required: true,
      },
      { key: 'refreshToken', label: 'Refresh Token', type: 'password', scope: 'secret' },
      { key: 'expiresAt', label: '到期时间', type: 'text', scope: 'config' },
      { key: 'scope', label: '授权范围', type: 'text', scope: 'config' },
    ],
    hintField: 'accessToken',
    hintMode: 'tail',
  },
  {
    provider: 'lark',
    key: 'lark-app',
    kind: 'static',
    label: '飞书自建应用（App ID / Secret）',
    description:
      '飞书开放平台自建应用的 App ID / App Secret，以应用（bot）身份调用；写入 lark-cli 配置目录。身份面注意：bot 只能调支持应用身份的命令，通讯录搜索等 user-only 命令会报 only supports user（不是凭据门的问题）',
    fields: [
      {
        key: 'appId',
        label: 'App ID',
        type: 'text',
        scope: 'config',
        required: true,
        placeholder: 'cli_…',
      },
      {
        key: 'appSecret',
        label: 'App Secret',
        type: 'password',
        scope: 'secret',
        required: true,
      },
    ],
    // 应用密钥取尾部做提示（`****abcd` 能认出是哪一套应用）
    hintField: 'appSecret',
    hintMode: 'tail',
    /**
     * 实测口径（2026-11-21）：lark-cli 接受明文 `appSecret` 字符串
     * （二进制校验文案 "appSecret must be a string or {source, id} object"）。
     * 路径按真实 CLI 布局放在 `~/.lark-cli/`，**不是** `~/.config/lark-cli/`。
     */
    inject: [
      {
        type: 'file',
        path: '~/.lark-cli/config.json',
        template: '{\n  "appId": "${config.appId}",\n  "appSecret": "${secret.appSecret}"\n}\n',
      },
    ],
  },
]

/**
 * 模板 key → 模板（`key` 缺省等于 `provider`）。
 *
 * 同一 provider 可以有多份模板：`lark`（用户授权）与 `lark-app`（自建应用 AK/SK）并存，
 * 靠 key 区分；入库的 `template` 列、AAD、注入规则解析全都按 key 走。
 */
const BY_KEY = new Map(TEMPLATES.map((template) => [template.key ?? template.provider, template]))

/** 模板的稳定标识（没有显式 `key` 时就是 provider） */
export const credentialTemplateKeyOf = (template: CredentialTemplate): string =>
  template.key ?? template.provider

/** 全部内置模板（管理端展示 / 市场预填用；按 provider 排序，结果稳定） */
export const CREDENTIAL_TEMPLATES: readonly CredentialTemplate[] = [...TEMPLATES].sort(
  (left, right) => left.provider.localeCompare(right.provider),
)

/**
 * 按**模板 key** 取（管理端表单选的是 key，不是 provider）。
 *
 * 同 provider 多模板时，只有 key 能唯一定位一份模板。
 */
export const credentialTemplateByKey = (key: string): CredentialTemplate | undefined =>
  BY_KEY.get(key.trim())

/**
 * 取模板：显式 `template`（模板 key）优先，缺省回落 provider 同名模板。
 *
 * 返回 `undefined` 表示"没有这份模板"（未收录的 provider / 字段模板被改名），
 * 由调用方决定报错口径 —— 共享层不抛业务错误。
 */
export const credentialTemplateOf = (
  provider: string,
  template?: string | null,
): CredentialTemplate | undefined => {
  const key = template?.trim() || provider
  return BY_KEY.get(key)
}
