import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServiceTemplate } from './cli/templates/service.js'

/**
 * 脚手架模板守卫（`pnpm check:scaffold`）。
 *
 * 背景：CLI 脚手架（`scripts/cli/templates/files/`）是 `@repo/kits` / `@repo/shared` 的**下游副本**，
 * 包里的导出一旦改名或删除（如 `QueueModule` 随 BullMQ 移除、`Logger` 被 `NestLoggerAdapter` 取代），
 * 模板会静默失效 —— 直到有人真的生成新项目才发现编译不过。本脚本把这类漂移挡在前面：
 *
 * 1. **名称检查**：抽取全部模板中来自 `@repo/kits` / `@repo/shared` 的具名导入，汇总成一个探针文件，
 *    缺任何一个导出都会被 tsc 报错（覆盖 crud / client 等无法整体渲染的模板）；
 * 2. **整体检查**：按 `templates/service.ts` 的真实文件映射把 service 模板全部渲染成一套完整
 *    应用源码，真实类型检查 —— 连配置形状（如 `forRootAsync` 工厂返回值不能是 `undefined`、
 *    `superRefine` 校验）一起验；新增模板会自动纳入，不必改本脚本。
 *
 * 探针目录放在 `apps/server/` 下（不是 `src/`），这样 `@repo/kits` 按真实 node_modules 解析，
 * 又不会被 server 自身的 tsconfig 收进去；跑完即删。
 */
const serverDir = fileURLToPath(new URL('../apps/server/', import.meta.url))
const templatesDir = fileURLToPath(new URL('./cli/templates/files/', import.meta.url))
const checkDir = join(serverDir, '.scaffold-check')

/** 会被检查的工作区包（`@repo/ui` 属前端，不在本脚本范围） */
const TRACKED_PACKAGES = ['@repo/kits', '@repo/shared'] as const

/** 递归收集模板文件 */
function collectTemplates(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return collectTemplates(full)
    return entry.name.endsWith('.eta') ? [full] : []
  })
}

/** 具名导入按「值 / 类型」分组：值的导入在 verbatimModuleSyntax 下必须真的是值，类型反之 */
interface ImportedNames {
  value: Set<string>
  type: Set<string>
}

/** 抽取某个包在各模板中的具名导入（跨行 import 一并覆盖） */
function collectImportedNames(): Map<string, ImportedNames> {
  const found = new Map<string, ImportedNames>(
    TRACKED_PACKAGES.map((pkg) => [pkg, { value: new Set<string>(), type: new Set<string>() }]),
  )
  const importPattern = /import\s+(type\s+)?\{([\s\S]*?)\}\s+from\s+'([^']+)'/g

  for (const file of collectTemplates(templatesDir)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(importPattern)) {
      const target = found.get(match[3] as (typeof TRACKED_PACKAGES)[number])
      if (!target) continue
      const importIsTypeOnly = Boolean(match[1])
      for (const specifier of match[2].split(',')) {
        const trimmed = specifier.trim()
        // 兼容 `type X` 与 `X as Y`，只取原始导出名
        const isType = importIsTypeOnly || /^type\s/.test(trimmed)
        const name = trimmed.replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim()
        // crud 模板的 DTO 名由 CLI 现场生成（`CursorQuery<%= it.modulePascal %>Dto`），
        // 不是工作区包的导出，跳过；同时挡掉 `// 注释` 之类的碎片
        if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) continue
        target[isType ? 'type' : 'value'].add(name)
      }
    }
  }
  return found
}

/** 生成「所有模板导入名」探针：缺导出、或值与类型错配，都会编译失败 */
function writeImportProbe(imports: Map<string, ImportedNames>): number {
  const lines = [
    '// 由 pnpm check:scaffold 自动生成：汇总所有脚手架模板的工作区包导入，用于校验导出是否仍存在',
  ]
  let total = 0
  for (const [pkg, names] of imports) {
    // 同一名字既按值又按类型出现时，以「值」为准 —— 若它其实是纯类型，正是应当报出来的错
    const values = [...names.value].sort()
    const types = [...names.type].filter((name) => !names.value.has(name)).sort()
    if (values.length > 0) {
      total += values.length
      lines.push(`import { ${values.join(', ')} } from '${pkg}'`)
    }
    if (types.length > 0) {
      total += types.length
      lines.push(`import type { ${types.join(', ')} } from '${pkg}'`)
    }
  }
  lines.push('', 'export const scaffoldImportProbe = true', '')
  writeFileSync(join(checkDir, 'src', '__imports__.ts'), lines.join('\n'), 'utf8')
  return total
}

/** 按 templates/service.ts 的真实文件映射渲染完整服务端骨架（新增模板自动纳入检查） */
function writeServiceScaffold(): number {
  const { files } = createServiceTemplate('scaffold-check')
  let written = 0
  for (const [relative, content] of Object.entries(files)) {
    // 只落 .ts：package.json / tsconfig.json 由本脚本自己生成
    // （探针 tsconfig 必须覆盖模板里的那份，否则 rootDir / include 指向错误）
    if (!relative.endsWith('.ts')) continue
    const target = join(checkDir, relative)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
    written += 1
  }
  return written
}

function run(): void {
  mkdirSync(join(checkDir, 'src', 'lib'), { recursive: true })
  writeFileSync(
    join(checkDir, 'tsconfig.json'),
    `${JSON.stringify(
      {
        extends: '../tsconfig.json',
        compilerOptions: { rootDir: '.' },
        include: ['**/*.ts'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  const importedNames = writeImportProbe(collectImportedNames())
  const renderedFiles = writeServiceScaffold()
  console.log(
    `[check:scaffold] 探针就绪：导入名 ${importedNames} 个 + service 模板 ${renderedFiles} 个文件`,
  )

  const result = spawnSync(
    'pnpm',
    ['exec', 'tsc', '--noEmit', '-p', '.scaffold-check/tsconfig.json'],
    { cwd: serverDir, encoding: 'utf8' },
  )
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()

  if (result.status !== 0) {
    console.error('[check:scaffold] ❌ 脚手架模板与工作区包已不一致：')
    console.error(output || '（tsc 无输出，退出码非 0）')
    console.error(
      '\n修复方向：同步 scripts/cli/templates/files/ 下的模板（导出名 / 配置形状），而不是放宽本检查。',
    )
    process.exitCode = 1
    return
  }
  console.log('[check:scaffold] ✅ 模板导入的导出名与渲染结果均通过类型检查')
}

try {
  run()
} finally {
  // 探针目录每次重建：避免上一次中断留下的文件污染本次结论
  rmSync(checkDir, { recursive: true, force: true })
}
