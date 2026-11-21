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
  /**
   * **初始化 / 登录态命令**的子命令前缀（不含命令名本身）。
   *
   * 这类命令的目的正是「把凭据配进去 / 看登录态」，凭据预检必须放行，
   * 否则第一次配置就死在预检上（清单里还没有该 provider 的条目，永远过不了门）。
   * 前缀只豁免**这一段**，复合命令里的业务段照旧检查。
   */
  bootstrap?: readonly (readonly string[])[]
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
    bootstrap: [
      ['auth', 'login'],
      ['auth', 'status'],
      ['auth', 'refresh'],
      ['auth', 'logout'],
    ],
    importFrom: { kind: 'command', command: 'gh auth token', extract: 'line', field: 'token' },
    status: 'gh auth status',
    longTerm: true,
  },
  {
    key: 'lark',
    commands: ['lark', 'lark-cli'],
    template: 'lark',
    bootstrap: [
      ['config', 'init'],
      ['config', 'bind'],
      ['config', 'show'],
      ['auth', 'login'],
      ['auth', 'status'],
      ['auth', 'list'],
      ['doctor'],
    ],
    /**
     * **刻意没有 `importFrom`**：真实 lark-cli（2026.11）把 token / appSecret 加密存在
     * `~/.local/share/lark-cli/`（master.key + *.enc），配置在 `~/.lark-cli/config.json` 且不含 token，
     * 也没有任何明文导出命令（`auth status` 只给 scope / 到期时间，`config show` 掩码）。
     * 声明一个永远读不出值的导入来源，只会让 candidates 永远不出现、import 取空 —— 那是假能力。
     * 「保存用户主动给出的值」走 `credential-save`，不在这里假装能导入。
     */
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
