/**
 * 构建期资产拷贝：把 `src` 下的非 TS 资产按原目录结构拷到 `dist`。
 *
 * 两类资产：
 * 1. 提示词模板 `*.eta` 与技能正文 `*.md` —— 按扩展名收；
 * 2. **技能目录整树**（`modules/ai/core/skills/catalog/**`）—— 按 Agent Skills 规范，
 *    技能自带 `scripts/` / `references/` / `assets/`，类型不限（如 `html-page` 的
 *    `scripts/build-html.mjs` 是 JS）。只按扩展名收会把脚本漏在镜像外，
 *    表现是"模型读技能里的脚本 → 文件不存在"。
 *
 * 为什么需要：server 用 `tsc` 构建，**tsc 只编译 TS、不搬其它文件**。这些资产是运行时
 * 用 `import.meta.dirname` 相对定位读取的（dev 走 src、构建后走 dist），少了这一步，
 * 生产镜像里模板目录 / 技能目录就是空的 → 启动即报「模板渲染失败」或技能缺文件。
 *
 * 用 `.ts` + Node 原生类型剥离（Node 26 起无需 tsx）：构建期与 dev 都直接 `node` 运行。
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

/** 需要随构建拷贝的资产扩展名（提示词模板 `.eta` 与技能正文 `.md`；技能目录不靠这个） */
const ASSET_EXTENSIONS: string[] = ['.eta', '.md']
/** 技能目录（相对 `src`）：整树随包，脚本 / 参考文件 / 素材都在里面 */
const SKILL_CATALOG = join('modules', 'ai', 'core', 'skills', 'catalog')
const SRC = 'src'
const DIST = 'dist'

/** 是否该随构建拷贝：技能目录整树，其余看扩展名 */
const shouldCopy = (full: string): boolean => {
  const path = relative(SRC, full)
  if (path === SKILL_CATALOG || path.startsWith(SKILL_CATALOG + sep)) return true
  return ASSET_EXTENSIONS.some((ext) => full.endsWith(ext))
}

/** 递归收集 `dir` 下需要拷贝的文件 */
const collect = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return collect(full)
    return shouldCopy(full) ? [full] : []
  })

if (!existsSync(SRC)) {
  console.error(`[copy-assets] 源目录不存在: ${SRC}（请在 app 目录下运行）`)
  process.exit(1)
}
if (!existsSync(DIST)) {
  console.error(`[copy-assets] 构建产物目录不存在: ${DIST}（先跑 tsc）`)
  process.exit(1)
}

const assets = collect(SRC)
for (const file of assets) {
  const target = join(DIST, relative(SRC, file))
  mkdirSync(dirname(target), { recursive: true })
  cpSync(file, target)
}
console.log(`[copy-assets] 已拷贝 ${assets.length} 个资产到 ${DIST}/`)
