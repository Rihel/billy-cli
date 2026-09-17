import { spawn } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import colors from 'picocolors'

/**
 * codegraph 可选工具初始化（pnpm codegraph:setup）：
 * 装 CLI（未装时）→ 在仓库根建索引，之后即可用 codegraph 查代码图谱。
 *
 * 定位：可选增强，不进依赖树、不入仓库，需手动跑一次（新环境 / 新 agent 都要执行）。
 * 网络：走 npm（国内镜像可通）；codegraph 官方的 install.sh 走 GitHub Releases CDN，国内常超时。
 * 详见 skill `codegraph`（.agents/skills/codegraph/）。
 */

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE = '@colbymchenry/codegraph'

/** 执行命令，返回退出码（继承 stdio） */
const run = (command: string, args: string[]): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd: workspaceRoot, stdio: 'inherit' })
    child.once('error', () => resolve(1))
    child.once('exit', (code) => resolve(code ?? 1))
  })

/** codegraph 是否已可用（静默探测） */
const hasCodegraph = (): Promise<boolean> =>
  new Promise((resolve) => {
    const child = spawn('codegraph', ['version'], { stdio: 'ignore' })
    child.once('error', () => resolve(false))
    child.once('exit', (code) => resolve(code === 0))
  })

const main = async (): Promise<void> => {
  console.log(colors.bold(colors.cyan('\ncodegraph 初始化（可选工具）')))

  if (await hasCodegraph()) {
    console.log(colors.green('  ✓ codegraph 已安装，跳过 CLI 安装'))
  } else {
    console.log(colors.cyan(`  安装 ${PACKAGE}（走 npm；国内配镜像则可通）...`))
    if ((await run('npm', ['i', '-g', PACKAGE])) !== 0) {
      console.error(
        colors.red('  ✗ 安装失败：请确认 npm 可用与网络；国内建议配置 registry 镜像后重试'),
      )
      process.exit(1)
    }
    console.log(colors.green('  ✓ CLI 安装完成'))
  }

  console.log(colors.cyan('  建索引（仓库根生成 .codegraph/，已 gitignore）...'))
  if ((await run('codegraph', ['init'])) !== 0) {
    console.error(colors.red('  ✗ codegraph init 失败'))
    process.exit(1)
  }

  console.log(colors.bold(colors.green('\n✅ 完成，可用 codegraph 查代码图谱')))
  console.log(
    `  可选：${colors.cyan('codegraph install')}  接 agent MCP（会改本机 agent 配置，按需执行）`,
  )
  console.log(`  看图：${colors.cyan('codegraph ui')}（http://127.0.0.1:4747）`)
  console.log(colors.yellow('  用法见 skill `codegraph`。'))
}

main().catch((error: unknown) => {
  console.error(colors.red(`codegraph 初始化失败：${(error as Error).message}`))
  process.exit(1)
})
