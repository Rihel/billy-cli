import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServiceTemplate } from './cli/templates/service.js'
import { pascalize } from './cli/templates/crud.js'

/**
 * 脚手架模板守卫（`pnpm check:scaffold`）。
 *
 * 背景：CLI 脚手架（`scripts/cli/templates/files/`）是 `@repo/kits` / `@repo/shared` 的**下游副本**，
 * 包里的导出一旦改名或删除（如 `QueueModule` 随 BullMQ 移除、`Logger` 被 `NestLoggerAdapter` 取代），
 * 模板会静默失效 —— 直到有人真的生成新项目才发现编译不过。本脚本把这类漂移挡在前面，三件事：
 *
 * 1. **名称检查**：抽取全部模板中来自 `@repo/kits` / `@repo/shared` 的具名导入，汇总成探针文件，
 *    缺任何一个导出都会被 tsc 报错；
 * 2. **service 整体检查**：按 `templates/service.ts` 的真实文件映射把 service 模板全部渲染成一套
 *    完整应用源码（放在 `apps/server/.scaffold-check/`），真实类型检查 —— 连配置形状
 *    （`forRootAsync` 工厂返回值、`superRefine`）一起验；新增模板自动纳入；
 * 3. **crud 整体检查**：**真的调用 CLI**（`pnpm cli -t crud`，stdin 非 TTY 故用默认字段）生成模块，
 *    再补上 CLI 提示的两个手动步骤（schema 导出、错误码登记），重建 `@repo/shared`，然后用
 *    `apps/server` 自己的 tsconfig 类型检查，最后删干净并把两个被改动的文件还原。
 *    用连字符名 `scaffold-probe`，顺带锁住「模块名 → PascalCase 标识符」的转换。
 *
 * **两个已知前提（脚本会检查 / 提示）**：
 * - tsc 把 `@repo/kits` / `@repo/shared` 解析到它们的**构建产物** `dist/*.d.mts`（不是 src），
 *   所以刚改完 packages 源码要先 `pnpm build:pkgs`，否则本检查是在对着旧产物做判断（脚本会告警）；
 * - crud 检查会**临时改动** `packages/shared/src/{schema/index.ts,dicts/app-error-code.dict.ts}`
 *   并在 `apps/server` 下写入生成物，跑完即还原（含中断残留的自清理）。
 */
const workspaceRoot = fileURLToPath(new URL('..', import.meta.url))
const serverDir = join(workspaceRoot, 'apps/server')
const templatesDir = join(workspaceRoot, 'scripts/cli/templates/files')
const checkDir = join(serverDir, '.scaffold-check')

/** 会被检查的工作区包（`@repo/ui` 属前端，不在本脚本范围） */
const TRACKED_PACKAGES = ['@repo/kits', '@repo/shared'] as const

// ---- crud 探针涉及的路径与标记 ----
const CRUD_NAME = 'scaffold-probe'
const CRUD_PASCAL = pascalize(CRUD_NAME)
const CRUD_MODULE_DIR = join(serverDir, 'src/modules', CRUD_NAME)
const CRUD_ENTITY_FILE = join(serverDir, 'src/database/entities', `${CRUD_NAME}-entity.ts`)
const crudSchemaFile = join(workspaceRoot, 'packages/shared/src/schema', `${CRUD_NAME}.schema.ts`)
const sharedSchemaIndex = join(workspaceRoot, 'packages/shared/src/schema/index.ts')
const sharedDictFile = join(workspaceRoot, 'packages/shared/src/dicts/app-error-code.dict.ts')
const SCHEMA_EXPORT_LINE = `export * from './${CRUD_NAME}.schema'\n`
const DICT_START = '  // __check_scaffold__ start（pnpm check:scaffold 探针条目，跑完自动删除）\n'
const DICT_END = '  // __check_scaffold__ end\n'

// ---------------------------------------------------------------- 工具

/** 递归收集模板文件 */
function collectTemplates(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return collectTemplates(full)
    return entry.name.endsWith('.eta') ? [full] : []
  })
}

/** 目录内最新的文件修改时间（用于判断 packages 产物是否比源码旧） */
function newestMtime(dir: string): number {
  if (!existsSync(dir)) return 0
  return readdirSync(dir, { withFileTypes: true }).reduce((acc, entry) => {
    const full = join(dir, entry.name)
    return entry.isDirectory()
      ? Math.max(acc, newestMtime(full))
      : Math.max(acc, statSync(full).mtimeMs)
  }, 0)
}

/** 产物比源码旧时告警：否则本检查是在对着旧类型做判断（假绿的经典来源） */
function warnIfDistStale(): void {
  for (const pkg of TRACKED_PACKAGES) {
    const name = pkg.replace('@repo/', '')
    const srcDir = join(workspaceRoot, 'packages', name, 'src')
    const distDir = join(workspaceRoot, 'packages', name, 'dist')
    if (newestMtime(srcDir) > newestMtime(distDir)) {
      console.warn(
        `[check:scaffold] ⚠️  packages/${name} 的源码比 dist 新 —— 请先 pnpm build:pkgs，` +
          '本次结论基于旧产物。',
      )
    }
  }
}

/** 跑一条命令并返回 { ok, output } */
function runCommand(command: string, args: string[], cwd: string, stdin: 'ignore' | 'inherit') {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: [stdin, 'pipe', 'pipe'] })
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  }
}

// ---------------------------------------------------------------- 检查 1：导入名

/** 具名导入按「值 / 类型」分组：值的导入在 verbatimModuleSyntax 下必须真的是值，类型反之 */
interface ImportedNames {
  value: Set<string>
  type: Set<string>
}

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

// ---------------------------------------------------------------- 检查 2：service 整体

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

// ---------------------------------------------------------------- 检查 3：crud 整体

/** 清掉上一次中断留下的 crud 残留，并把被临时改动的两个文件还原 */
function resetCrudArtifacts(): void {
  rmSync(CRUD_MODULE_DIR, { recursive: true, force: true })
  rmSync(CRUD_ENTITY_FILE, { force: true })
  rmSync(crudSchemaFile, { force: true })
  rmSync(crudSchemaFile.replace(/\.schema\.ts$/, '-entity.ts'), { force: true })

  for (const file of [sharedSchemaIndex, sharedDictFile]) {
    if (!existsSync(file)) continue
    const source = readFileSync(file, 'utf8')
    let cleaned = source.replace(SCHEMA_EXPORT_LINE, '')
    const start = cleaned.indexOf(DICT_START)
    const end = cleaned.indexOf(DICT_END)
    if (start !== -1 && end !== -1) {
      cleaned = cleaned.slice(0, start) + cleaned.slice(end + DICT_END.length)
    }
    if (cleaned !== source) writeFileSync(file, cleaned, 'utf8')
  }
}

/** 补上 CLI 提示里两个「手动步骤」（仅编译相关）：schema 导出、错误码登记 */
function injectCrudManualSteps(): void {
  const indexSource = readFileSync(sharedSchemaIndex, 'utf8')
  if (!indexSource.includes(SCHEMA_EXPORT_LINE.trim())) {
    writeFileSync(sharedSchemaIndex, `${indexSource}${SCHEMA_EXPORT_LINE}`, 'utf8')
  }

  const dictSource = readFileSync(sharedDictFile, 'utf8')
  const closing = dictSource.lastIndexOf('})')
  if (closing === -1) throw new Error(`未找到字典结尾：${sharedDictFile}`)
  const entry =
    DICT_START +
    `  ${CRUD_PASCAL}NotFound: {\n` +
    `    label: '${CRUD_PASCAL} 不存在',\n` +
    '    value: 3901,\n' +
    '    http: 404,\n' +
    '  },\n' +
    DICT_END
  writeFileSync(sharedDictFile, dictSource.slice(0, closing) + entry + dictSource.slice(closing), 'utf8')
}

function runCrudProbe(): { ok: boolean; output: string } {
  resetCrudArtifacts()

  // 用真实 CLI 生成（stdin 设为 ignore：非 TTY 时 CLI 用默认字段，不会挂起等输入）
  const cli = runCommand(
    'pnpm',
    ['cli', '-t', 'crud', '-n', CRUD_NAME, '--no-install'],
    workspaceRoot,
    'ignore',
  )
  if (!cli.ok) return { ok: false, output: `CLI 生成失败：\n${cli.output}` }

  try {
    injectCrudManualSteps()

    // tsc 读的是 dist 声明，故生成物必须先进 dist
    const build = runCommand('pnpm', ['--filter', '@repo/shared', 'build'], workspaceRoot, 'ignore')
    if (!build.ok) return { ok: false, output: `重建 @repo/shared 失败：\n${build.output}` }

    const tsc = runCommand(
      'pnpm',
      ['exec', 'tsc', '--noEmit', '-p', 'tsconfig.json'],
      serverDir,
      'ignore',
    )
    return { ok: tsc.ok, output: tsc.output }
  } finally {
    resetCrudArtifacts()
    // dist 里也要把探针 schema 去掉，否则后续构建会带着它
    runCommand('pnpm', ['--filter', '@repo/shared', 'build'], workspaceRoot, 'ignore')
  }
}

// ---------------------------------------------------------------- 主流程

function run(): void {
  warnIfDistStale()

  // 检查 1 + 2：探针应用
  mkdirSync(join(checkDir, 'src', 'lib'), { recursive: true })
  writeFileSync(
    join(checkDir, 'tsconfig.json'),
    `${JSON.stringify(
      { extends: '../tsconfig.json', compilerOptions: { rootDir: '.' }, include: ['**/*.ts'] },
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

  const service = runCommand(
    'pnpm',
    ['exec', 'tsc', '--noEmit', '-p', '.scaffold-check/tsconfig.json'],
    serverDir,
    'inherit',
  )

  // 检查 3：crud（真实 CLI + 真实 apps/server tsconfig）
  const crud = runCrudProbe()
  console.log(`[check:scaffold] crud 探针：${CRUD_NAME}（模块 + 实体 + schema + 手动步骤）`)

  if (!service.ok || !crud.ok) {
    console.error('[check:scaffold] ❌ 脚手架模板与工作区包已不一致：')
    if (!service.ok) {
      console.error('\n--- service 渲染结果 ---')
      console.error(service.output || '（tsc 无输出，退出码非 0）')
    }
    if (!crud.ok) {
      console.error('\n--- crud 渲染结果 ---')
      console.error(crud.output || '（tsc 无输出，退出码非 0）')
    }
    console.error(
      '\n修复方向：同步 scripts/cli/templates/files/ 下的模板（导出名 / 配置形状 / 生成物与手动步骤的配合），' +
        '而不是放宽本检查。',
    )
    process.exitCode = 1
    return
  }
  console.log('[check:scaffold] ✅ 导入名、service 骨架与 crud 模块均通过类型检查')
}

try {
  run()
} finally {
  // 探针目录每次重建：避免上一次中断留下的文件污染本次结论
  rmSync(checkDir, { recursive: true, force: true })
}
