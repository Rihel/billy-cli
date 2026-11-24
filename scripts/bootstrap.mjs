import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * `pnpm bootstrap` 的入口（纯 Node，不依赖任何第三方包）。
 *
 * 为什么需要这层壳：引导脚本 `scripts/setup.ts` 自己跑在 `tsx` 上，而 tsx 属于
 * devDependencies —— 全新克隆的仓库没有 `node_modules`，直接
 * `node --import tsx/esm scripts/setup.ts` 会在第一行就 ERR_MODULE_NOT_FOUND。
 * 这里先补齐依赖（跑一次 `pnpm install`），再把参数原样交给 setup.ts。
 *
 * 只做这一件事，其余步骤（检查 / 生成 .env / 构建 / 迁移 / 种子 / 冒烟）仍在 setup.ts。
 */

const root = fileURLToPath(new URL('..', import.meta.url))
const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

/** tsx 在 node_modules 里是符号链接，用 package.json 判断更稳 */
const tsxReady = () => existsSync(join(root, 'node_modules/tsx/package.json'))

if (!tsxReady()) {
  console.log('未检测到依赖（node_modules/tsx），先执行 pnpm install ...')
  const install = spawnSync(pnpmBin, ['install'], {
    cwd: root,
    stdio: 'inherit',
    // Windows 上 .cmd 需要 shell 才能被 spawn
    shell: process.platform === 'win32',
  })
  if (install.status !== 0) {
    console.error('依赖安装失败，bootstrap 中止')
    process.exit(install.status ?? 1)
  }
  // node_modules 已存在但缺包时 pnpm 可能判定「Already up to date」而不补链接，明确提示修复方式
  if (!tsxReady()) {
    console.error(
      '依赖不完整：node_modules 里缺少 tsx。请在仓库根执行 `pnpm install --force` 后重试。',
    )
    process.exit(1)
  }
}

const setup = spawnSync(
  process.execPath,
  ['--import', 'tsx/esm', 'scripts/setup.ts', ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit' },
)

process.exit(setup.status ?? 1)
