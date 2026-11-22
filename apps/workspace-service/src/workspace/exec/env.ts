/**
 * exec 的环境变量前缀包装（k8s / local 后端用）。
 *
 * 为什么必须逐字符转义：env 的值将来装的是凭据（密码 / AK-SK / Token），
 * 最终会被拼进 `sh -c` 的命令文本里。只要有一个字符没被引号锁住
 * （空格、单引号、`$`、反引号、分号、换行……），它就会从「值」变成 shell 语法，
 * 整条命令即被改写 —— 等同于命令注入。所以这里一律用单引号包住，
 * 并把值内部的 `'` 转成 `'\''`，让整段值在 shell 眼里只是一个不可解释的字面量。
 */

/** 用单引号包裹一个 shell 字面量；内部单引号转义成 `'\''` */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

/**
 * 给命令套上 `env 'K=V' 'K2=V2' sh -c '<command>'`。
 *
 * **必须是 `sh -c` 而不是简单前缀**：`env A=1 cmd1; cmd2` 里 `env` 只作用于 `cmd1`，
 * `cmd2` 里的 `$A` 仍由外层 shell 展开（拿到空值）。初始化阶段注入的凭据变量要覆盖
 * 整条命令行（含 `&&` / `;` 链与 `$VAR` 展开），所以把整段命令交给内层 shell。
 *
 * - 无 env（`undefined` 或空对象）时原样返回，不改变未注入环境变量时的行为；
 * - 键按字典序排序，保证同样的输入永远得到同样的字符串，可断言、可复现；
 * - 先把键值拼成 `K=V` 再整体单引号包裹；环境变量名由契约限制为 POSIX 变量名。
 */
export const withEnvPrefix = (command: string, env?: Record<string, string>): string => {
  const entries = Object.entries(env ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )
  if (entries.length === 0) return command
  const assignments = entries.map(([key, value]) => shellQuote(`${key}=${value}`))
  return `env ${assignments.join(' ')} sh -c ${shellQuote(command)}`
}

/**
 * 按执行环境的 shell 生成环境变量注入前缀。
 *
 * - `sh`：`env 'K=V' sh -c '<command>'`（见 {@link withEnvPrefix}）；
 * - `cmd`：`set "K=V" && <command>`，值里的 `^ & | < > ( )` 用 `^` 转义。
 *   含 `"` / `%` / 换行的值**直接报错**：cmd 没有可靠的转义，拼错等于命令注入。
 */
export type EnvShell = 'sh' | 'cmd'

const cmdEscape = (value: string): string => value.replace(/[\^&|<>()]/g, (char) => `^${char}`)

export const withEnvPrefixFor = (
  shell: EnvShell,
  command: string,
  env?: Record<string, string>,
): string => {
  const entries = Object.entries(env ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )
  if (entries.length === 0) return command
  if (shell === 'sh') return withEnvPrefix(command, env)
  const sets = entries.map(([key, value]) => {
    if (/["%\r\n]/.test(value)) {
      throw new Error(`环境变量 ${key} 含 cmd 无法安全转义的字符（" / % / 换行）`)
    }
    return `set "${key}=${cmdEscape(value)}"`
  })
  return `${sets.join(' && ')} && ${command}`
}
