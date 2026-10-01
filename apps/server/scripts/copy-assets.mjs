/**
 * 构建期资产拷贝：把 `src` 下的非 TS 资产（目前是提示词模板 `*.eta`）按原目录结构拷到 `dist`。
 *
 * 为什么需要：server 用 `tsc` 构建，**tsc 只编译 TS、不搬其它文件**。提示词模板是运行时
 * 用 `import.meta.dirname` 相对定位读取的（dev 走 src、构建后走 dist），少了这一步，
 * 生产镜像里 `dist/modules/ai/core/prompts/templates/` 就是空的 → 启动即报「模板渲染失败」。
 *
 * 用 `.mjs` 而不是 TS：构建脚本要能在**没有 tsx 的 runner 阶段**、且 devDeps 齐全的 builder
 * 阶段都稳定运行，纯 Node ESM 最省事。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

/** 需要随构建拷贝的资产扩展名（提示词模板 `.eta` 与技能文件 `.md`；新增其它资产时加到这里） */
const ASSET_EXTENSIONS = ['.eta', '.md']
const SRC = 'src'
const DIST = 'dist'

/** 递归收集 `dir` 下匹配扩展名的文件 */
const collect = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return collect(full)
    return ASSET_EXTENSIONS.some((ext) => entry.name.endsWith(ext)) ? [full] : []
  })

if (!existsSync(SRC)) {
  console.error(`[copy-assets] 源目录不存在: ${SRC}（请在 apps/server 目录下运行）`)
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
