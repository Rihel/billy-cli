/**
 * CLI 适配器（`docs/design/workspace-cli-credentials.md` §6.5）。
 *
 * 只声明「怎么装、命令叫什么、凭据在哪里、怎么从容器里读出来」；
 * **没有适配器的 CLI 仍可正常使用**，只是缺命令识别、凭据预检与导入能力。
 */
export interface CliImportSource {
  kind: 'file' | 'command'
  /** file：容器内路径（支持 ~/）；command：读取命令 */
  path?: string
  command?: string
  /** 命令输出的解析方式 */
  extract?: 'json' | 'line'
  /** 从 JSON 里取值（`$.a.b`） */
  jsonPath?: string
  /** 解析出的值写进模板的哪个 secret 字段（缺省取模板唯一必填 secret 字段） */
  field?: string
}

export interface CliAdapter {
  key: string
  /** 命令名（用于执行前检查的命令识别） */
  commands: readonly string[]
  /** 对应字段模板 */
  template: string
  /** 导入来源；没有 = 该 CLI 不支持自动导入（如数据库口令） */
  importFrom?: CliImportSource
  /** 无副作用的登录态检查（导入后验证可用性；没有就跳过验证） */
  status?: string
  /** 导入到的是长期凭据还是短命 token（后者要在确认界面明示） */
  longTerm: boolean
}

export const CLI_ADAPTERS: readonly CliAdapter[] = [
  {
    key: 'github',
    commands: ['gh'],
    template: 'github',
    importFrom: { kind: 'command', command: 'gh auth token', extract: 'line', field: 'token' },
    status: 'gh auth status',
    longTerm: true,
  },
  {
    key: 'lark',
    commands: ['lark', 'lark-cli'],
    template: 'lark',
    importFrom: {
      kind: 'file',
      path: '~/.config/lark-cli/config.json',
      jsonPath: '$.token',
      field: 'accessToken',
    },
    longTerm: false,
  },
  { key: 'mysql', commands: ['mysql'], template: 'mysql', longTerm: true },
  { key: 'redis', commands: ['redis-cli'], template: 'redis', longTerm: true },
  { key: 'tencent-cloud', commands: ['tccli'], template: 'tencent-cloud', longTerm: true },
]

export const adapterOf = (provider: string): CliAdapter | undefined =>
  CLI_ADAPTERS.find((adapter) => adapter.key === provider)

/** provider → 会暴露凭据的命令（执行前检查用；与 §6.5 的 `commands` 同源） */
export const CREDENTIAL_COMMANDS: Record<string, readonly string[]> = Object.fromEntries(
  CLI_ADAPTERS.map((adapter) => [adapter.key, adapter.commands]),
)
