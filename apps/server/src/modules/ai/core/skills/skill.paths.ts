import { homedir } from 'node:os'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { SKILL_FILE_PATH_PATTERN, SKILL_KEY_PATTERN } from '@repo/shared'

/**
 * 技能路径规则（纯函数，无 IO）。
 *
 * 这一层是**唯一**决定"什么路径允许写"的地方：入参校验（shared 的 schema）、
 * 落盘（materializer）、导入（import）都走它。规则刻意窄：
 * - 技能名 = 目录名：小写字母 / 数字 / 连字符，≤64；
 * - 文件：`SKILL.md`，或 `references/` `scripts/` `assets/` 下的文本文件；
 * - 拒绝绝对路径、`..`、反斜杠、空段、`.` 段、超长。
 *
 * 为什么不用"黑名单过滤"：路径写入是本功能唯一的越界面（写到技能库根目录之外），
 * 白名单 + 落盘前再 `resolve` 一次校验（纵深防御）比逐条禁词可靠。
 */

/** 技能入口文件名（Agent Skills 标准） */
export const SKILL_FILE = 'SKILL.md'

/** 是不是一个合法的技能名 */
export const isValidSkillKey = (key: string): boolean => SKILL_KEY_PATTERN.test(key)

/** 归一化并校验技能名；不合法时抛错（调用方负责翻译成业务错误） */
export const normalizeSkillKey = (key: string): string => {
  const trimmed = key.trim()
  if (!isValidSkillKey(trimmed)) {
    throw new Error(
      `技能名不合法：${JSON.stringify(key)}（只能用 a-z / 0-9 / -，≤64，且以字母或数字开头）`,
    )
  }
  return trimmed
}

/**
 * 归一化并校验技能内的相对路径。
 *
 * 返回的一定是 POSIX 形式（`references/a.md`）—— 落盘时再转成本地分隔符。
 */
export const normalizeSkillFilePath = (path: string): string => {
  const trimmed = path.trim()
  if (trimmed.includes('\\')) throw new Error(`技能文件路径不能包含反斜杠：${path}`)
  if (trimmed.startsWith('/')) throw new Error(`技能文件路径必须是相对路径：${path}`)
  if (trimmed.length > 200) throw new Error(`技能文件路径过长：${trimmed.length} 字符`)
  if (!SKILL_FILE_PATH_PATTERN.test(trimmed)) {
    throw new Error(
      `技能文件路径不合法：${path}（只能是 SKILL.md，或 references/ scripts/ assets/ 下的文件）`,
    )
  }
  // 正则允许 `.` / `..` 作为合法字符组合，但它们是路径穿越的起点，这里显式拒绝
  if (trimmed.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`技能文件路径不能包含 . 或 .. 段：${path}`)
  }
  return trimmed
}

/** 文件类型：Markdown 用块编辑器，其余当代码 */
export const isMarkdownFile = (path: string): boolean => path.toLowerCase().endsWith('.md')

/** 技能的落盘目录（**未做越界校验**，仅供已知合法的 key 使用） */
export const skillDirOf = (root: string, skillKey: string): string =>
  join(root, normalizeSkillKey(skillKey))

/**
 * 把相对路径解析成本地绝对路径，并校验**仍在技能目录内**（纵深防御）。
 *
 * 归一化在入参层已经做过一遍；这里再算一次是因为落盘是"最后一道门"——
 * 即便将来有人绕过 schema 直接调 service，也不会把文件写到目录之外。
 */
export const resolveSkillFilePath = (
  root: string,
  skillKey: string,
  relativePath: string,
): string => {
  const dir = skillDirOf(root, skillKey)
  const target = resolve(dir, ...normalizeSkillFilePath(relativePath).split('/'))
  const prefix = dir.endsWith(sep) ? dir : dir + sep
  if (target !== dir && !target.startsWith(prefix)) {
    throw new Error(`技能文件路径越界：${relativePath}`)
  }
  return target
}

/** 归一化技能库根目录（相对路径按进程工作目录解析） */
export const normalizeSkillsRoot = (root: string): string => {
  const trimmed = root.trim()
  if (!trimmed) throw new Error('技能库目录不能为空')
  const expanded =
    trimmed === '~'
      ? homedir()
      : trimmed.startsWith('~/')
        ? join(homedir(), trimmed.slice(2))
        : trimmed
  return isAbsolute(expanded) ? normalize(expanded) : resolve(process.cwd(), expanded)
}
