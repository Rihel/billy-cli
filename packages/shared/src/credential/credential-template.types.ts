/** 凭据字段的输入形态（决定前端控件与后端校验） */
export type CredentialFieldType = 'text' | 'password' | 'number' | 'url'

/**
 * 字段去向：
 * - `config`：明文列（host / port / database / username / region …），可检索、可展示；
 * - `secret`：打包进密文信封，**永不出库、不落日志、不回显**。
 */
export type CredentialFieldScope = 'config' | 'secret'

/** 模板里的一个字段：表单长什么样、是否必填、进明文还是密文，全由它决定 */
export interface CredentialField {
  /** 字段名（`config` / `secret` 里的键，也是注入模板里 `${secret.xxx}` 的引用名） */
  key: string
  /** 中文标签（表单用） */
  label: string
  type: CredentialFieldType
  scope: CredentialFieldScope
  /** 必填（默认 false） */
  required?: boolean
  /** 缺省值（用户不填时补上） */
  default?: string | number
  /** 输入提示（placeholder） */
  placeholder?: string
  /** 字段说明（表单下方小字） */
  hint?: string
}

/**
 * 注入规则：把凭据写进容器里的配置文件或环境变量（§6.4.3）。
 *
 * - `file`：`path` + `template`，模板里的 `${secret.x}` / `${config.x}` 按字段路径取值；
 * - `env`：`name` 是环境变量名，`field` 指取哪个字段（缺省取唯一 secret 字段，多字段必须显式指定）。
 */
export type CredentialInjectRule =
  | { type: 'file'; path: string; template: string }
  | { type: 'env'; name: string; field?: string }

/**
 * 字段模板：**平台侧声明**（代码或后台数据），一份模板驱动前端表单、后端校验、
 * 注入与导入映射。新增一种资源只需新增模板，不改表、不加枚举。
 */
export interface CredentialTemplate {
  /** provider 标识（`mysql` / `redis` / `tencent-cloud` / `lark` / `github`） */
  provider: string
  /**
   * 模板 key（**同 provider 可挂多份模板**，如 lark 的 oauth 授权与自建应用 AK/SK）。
   *
   * 缺省等于 `provider`；模板检索、入库的 `template` 列、AAD 都按它取值。
   */
  key?: string
  /** 生命周期语义（`static` 不刷新 / `oauth` 可刷新 / `ssh-key` 预留） */
  kind: 'static' | 'oauth' | 'ssh-key'
  /** 中文展示名 */
  label: string
  /** 一句话说明（说明"填这些字段能干什么"） */
  description: string
  fields: CredentialField[]
  /** `secret_hint` 取哪个字段（认人用：数据库取用户名，云厂商取密钥尾部） */
  hintField?: string
  /** 提示值的展示方式：原样（用户名）/ 尾部（`AKID…abcd`） */
  hintMode?: 'plain' | 'tail'
  /** 默认注入规则（用户 / 市场可覆盖） */
  inject?: CredentialInjectRule[]
}

/** 归属主体（凭据 / 技能 / 工作区共用；与 `owner_type` 取值一致） */
export interface CredentialOwner {
  ownerType: 'user' | 'admin'
  ownerId: string
}

/** 凭据在谁名下、属于哪个身份体系（AAD 与归属过滤都用它） */
export interface CredentialAadInput extends CredentialOwner {
  id: string
  provider: string
  template: string
}

/**
 * AAD = `${id}|${owner_type}:${owner_id}|${provider}|${template}`（§6.4.2）。
 *
 * 作用：把密文与"它属于谁、是哪种凭据"绑定，防止把 A 行密文搬到 B 行。
 * 任何参与 AAD 的字段**写入后不得修改**（改 provider / template 必须重新加密）。
 */
export const credentialAadOf = (input: CredentialAadInput): string =>
  `${input.id}|${input.ownerType}:${input.ownerId}|${input.provider}|${input.template}`
