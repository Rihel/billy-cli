import { fileURLToPath } from 'node:url'
import process from 'node:process'
import colors from 'picocolors'
import { generate, installDependencies } from './cli/generator.js'
import { collectOptions, parseOptions } from './cli/options.js'
import { getTemplate, templateLabels } from './cli/templates/index.js'

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url))

async function main() {
  const cliOptions = parseOptions()
  console.log(colors.bold(colors.cyan('\nBilly Workspace Generator')))

  const options = await collectOptions(cliOptions)
  const template = getTemplate(options.type, options.name)
  const target = await generate(template, options.name, workspaceRoot)

  console.log(
    colors.green(`\n已生成 ${templateLabels[options.type]}：${target}`),
  )
  if (options.install) {
    console.log(colors.cyan('\n正在安装 workspace 依赖...'))
    await installDependencies(workspaceRoot)
  } else {
    console.log(colors.yellow('依赖尚未安装，请稍后运行 pnpm install。'))
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(colors.red(`\n生成失败：${message}`))
  process.exitCode = 1
})
