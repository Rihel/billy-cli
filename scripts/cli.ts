import { fileURLToPath } from 'node:url'
import process from 'node:process'
import colors from 'picocolors'
import { generate, installDependencies } from './cli/generator.js'
import { collectOptions, parseOptions } from './cli/options.js'
import { getTemplate, templateLabels } from './cli/templates/index.js'
import { entitySnippet } from './cli/templates/crud.js'

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url))

async function main() {
  const cliOptions = parseOptions()
  console.log(colors.bold(colors.cyan('\nBilly Workspace Generator')))

  const options = await collectOptions(cliOptions)
  const template = await getTemplate(options.type, options.name)
  const target = await generate(template, options.name, workspaceRoot)

  console.log(
    colors.green(`\n已生成 ${templateLabels[options.type]}：${target}`),
  )

  // CRUD 模块的后置提示
  if (options.type === 'crud') {
    const name = options.name
    const modulePascal = name.charAt(0).toUpperCase() + name.slice(1)
    console.log(colors.cyan('\n📋 接下来请手动完成以下步骤：'))

    console.log(
      `  ${colors.yellow('1.')} 在 ${colors.bold('packages/db/src/entities.ts')} 中添加 entity 定义（复制下方代码到 commonColumns 下面）：`,
    )

    console.log(colors.gray(entitySnippet(name, [])))

    console.log(
      `  ${colors.yellow('2.')} 在 ${colors.bold('apps/server/src/root.module.ts')} 中导入并注册 ${colors.bold(modulePascal + 'Module')}`,
    )
    console.log(
      `  ${colors.yellow('3.')} 在 ${colors.bold('packages/shared/src/dicts/app-error-code.dict.ts')} 中添加 ${colors.bold(modulePascal + 'NotFound')} 错误码`,
    )
    console.log(
      `  ${colors.yellow('4.')} 在 ${colors.bold('packages/shared/src/schema/index.ts')} 中导出新 schema`,
    )
    console.log(
      `  ${colors.yellow('5.')} 运行 ${colors.bold('pnpm db:gen')} 生成数据库迁移文件`,
    )
    console.log(
      colors.cyan('完成以上步骤后，运行 pnpm dev:server 即可使用新 CRUD 模块。\n'),
    )
  }

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
