/**
 * Mastra 边界守卫（设计 `docs/design/ai-agent-tool-engine.md` §5.8 / §5.9 的可执行版本）。
 *
 * 背景：工程写过「不把 Mastra 的词引进我们的领域」（`core/tools/tool-keys.ts`），但只写在注释里，
 * 于是 `@mastra/*` 的依赖一度散在 16 个文件里 —— 升级 Mastra 或换掉它，改动面是全摊开的。
 * 现在把它变成**目录边界**：
 *
 * - `apps/agent-runtime/src/modules/ai/core/tools/**`（工具引擎：DSL / 注册机 / 网关 / 插件 / 配置）**禁止** import；
 * - `apps/agent-runtime/src/modules/ai/tools/**`（具体工具，用引擎写）同样**禁止** import；
 * - `apps/agent-runtime/src/modules/ai/mastra/**`（适配器）**允许**，它是唯一的映射处；
 * - 其余文件进**允许清单**（文件路径 → 期望的 import 条数），**只减不增**：
 *   想新增一处依赖，必须显式改这个清单 —— 改动留痕，而不是靠 review 用眼睛找。
 *
 * 用法：`pnpm check:mastra`。
 */
import { readFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 主体目录（禁止 import `@mastra`）：工具引擎 + 具体工具 */
const FORBIDDEN_PREFIXES = [
  'apps/agent-runtime/src/modules/ai/core/tools/',
  'apps/agent-runtime/src/modules/ai/tools/',
]

/** 适配器目录（允许 import；新增文件不必改清单） */
const ALLOWED_PREFIXES = ['apps/agent-runtime/src/modules/ai/mastra/']

/**
 * 允许清单：**主体目录与适配器目录之外**仍需要 `@mastra` 的文件。
 *
 * Mastra 装配（`ai.mastra.ts`）已收进 `mastra/**`（适配器前缀本就豁免），不再登记在这里；
 * 剩下的都是消费 Mastra 类型 / 实例的运行时、agent 查询与技能文件。值是该文件当前的 import 条数：
 * 只许减少；新增或加量都会让守卫失败，逼着人显式决策。
 */
export const MASTRA_ALLOWLIST: Record<string, number> = {
  'apps/agent-runtime/src/modules/ai/agents/service.ts': 1,
  'apps/agent-runtime/src/modules/ai/runtime/chat.service.ts': 2,
  'apps/agent-runtime/src/modules/ai/runtime/recovery.service.ts': 1,
  'apps/agent-runtime/src/modules/ai/runtime/storage/agent-mastra-store.ts': 2,
  'apps/agent-runtime/src/modules/ai/runtime/title.service.ts': 1,
  'apps/agent-runtime/src/modules/ai/core/skills/skill.content.ts': 1,
}

/** 扫描根 */
const SCAN_ROOT = 'apps/agent-runtime/src'

export interface MastraViolation {
  file: string
  kind: 'forbidden' | 'not-allowed' | 'count-increased'
  detail: string
}

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full)
  }
  return out
}

/**
 * 去掉注释，避免注释里写 `import '@mastra...'` 被误判成依赖。
 *
 * 使用一个小型词法扫描而不是直接 regex：字符串里的 `//` 不能被当注释。
 */
const stripComments = (source: string): string => {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (quote) {
      out += char
      if (char === '\\') {
        out += source[++i] ?? ''
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      out += char
      continue
    }
    const next = source[i + 1]
    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (char === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++
      i += 1
      continue
    }
    out += char
  }
  return out
}

/**
 * 统计一个文件里对 `@mastra/*` 的依赖次数。
 *
 * 覆盖：静态 `import ... from` / `export ... from`、副作用 `import '@mastra'`、
 * 动态 `import()`、`require()`、类型位置的 `import('@mastra/...')`，双引号同样认。
 * 先剥注释，避免文档里的示例被算成依赖。
 *
 * 为什么不用 TypeScript Compiler API：仓库的 typescript@7 原生包只暴露版本号 /
 * unstable type-checker，不提供 `createSourceFile` 这类 AST 入口；这里用词法扫描兜住
 * 所有**可静态识别**的写法，比只扫 `from '@mastra` 的单引号字符串可靠得多。
 */
const countMastraImports = (content: string): number => {
  const source = stripComments(content)
  const spec = `['"]@mastra(?:/[^'"]*)?['"]`
  const patterns = [
    // import ... from / export ... from（含 import type）
    new RegExp(`\\bfrom\\s*${spec}`, 'g'),
    // 副作用 import '@mastra/...'
    new RegExp(`\\bimport\\s+${spec}`, 'g'),
    // 动态 import('@mastra/...')（类型位置的 import() 也长这样）
    new RegExp(`\\bimport\\s*\\(\\s*${spec}\\s*\\)`, 'g'),
    // require('@mastra/...')
    new RegExp(`\\brequire\\s*\\(\\s*${spec}\\s*\\)`, 'g'),
  ]
  let count = 0
  for (const pattern of patterns) count += source.match(pattern)?.length ?? 0
  return count
}

/** 纯函数：给定"文件 → 内容"，给出违规清单（便于单测直接喂内存数据） */
export const findMastraViolations = (
  files: Record<string, string>,
  allowlist: Record<string, number> = MASTRA_ALLOWLIST,
): MastraViolation[] => {
  const violations: MastraViolation[] = []
  for (const [file, content] of Object.entries(files)) {
    const count = countMastraImports(content)
    const forbidden = FORBIDDEN_PREFIXES.some((prefix) => file.startsWith(prefix))
    const allowed = ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix))
    if (forbidden && count > 0) {
      violations.push({
        file,
        kind: 'forbidden',
        detail: `主体目录禁止 import @mastra（发现 ${count} 处）—— 请改走 ai/mastra/** 适配器`,
      })
      continue
    }
    if (allowed || count === 0) continue
    const expected = allowlist[file]
    if (expected === undefined) {
      violations.push({
        file,
        kind: 'not-allowed',
        detail: `不在允许清单里（发现 ${count} 处）—— 首选改走适配器；确实必要就在脚本里登记条数`,
      })
      continue
    }
    if (count > expected) {
      violations.push({
        file,
        kind: 'count-increased',
        detail: `依赖条数从 ${expected} 涨到 ${count} —— 允许清单只减不增`,
      })
    }
  }
  return violations
}

/** 读盘并跑检查（CLI 入口） */
export const runCheck = (root = process.cwd()): MastraViolation[] => {
  const files: Record<string, string> = {}
  for (const full of walk(join(root, SCAN_ROOT))) {
    const content = readFileSync(full, 'utf8')
    files[relative(root, full).split('\\').join('/')] = content
  }
  return findMastraViolations(files)
}

const main = (): void => {
  const violations = runCheck()
  if (violations.length === 0) {
    console.log('✅ Mastra 边界检查通过（主体未引入 @mastra，允许清单未增长）')
    return
  }
  console.error(`❌ Mastra 边界检查失败（${violations.length} 处）：`)
  for (const violation of violations)
    console.error(`  - [${violation.kind}] ${violation.file}：${violation.detail}`)
  process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
