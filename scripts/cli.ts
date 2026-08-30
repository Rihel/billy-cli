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
      `  ${colors.yellow('1.')} 在 ${colors.bold('apps/server/src/main.ts')} 中导入 ${colors.bold(modulePascal + 'Repository')} / ${colors.bold(modulePascal + 'Service')}，并加入 createServiceContext 链式 ${colors.bold('.addService(...)')}`,
    )
    console.log(
      `  ${colors.yellow('2.')} 在 ${colors.bold('apps/server/src/main.ts')} 的 ${colors.bold('createServiceContext({ db: { entities } })')} 中注册 ${colors.bold(name + '-entity')}，并用 ${colors.bold('app.route(\'/' + name + '\', make' + modulePascal + 'Routes(runtime))')} 挂载路由`,
    )
    console.log(
      `  ${colors.yellow('3.')} 在 ${colors.bold('packages/shared/src/dicts/app-error-code.dict.ts')} 的 3xxx 段添加 ${colors.bold(modulePascal + 'NotFound')} 错误码`,
    )
    console.log(
      `  ${colors.yellow('4.')} 在 ${colors.bold('packages/shared/src/schema/index.ts')} 中导出新 schema`,
    )
    console.log(
      `  ${colors.yellow('5.')} 运行 ${colors.bold('pnpm db:gen')} 生成数据库迁移文件，再运行 ${colors.bold('pnpm db:migrate')} 执行迁移`,
    )
    console.log(
      `  ${colors.yellow('6.')} 在 ${colors.bold('packages/sdk/src/server.client.ts')} 中添加 ${colors.bold(name)} 段的类型化 SDK 方法`,
    )
    console.log(
      `  ${colors.yellow('7.')} 按 develop-frontend-page 规范开发 admin 页面并加入 ${colors.bold('apps/admin/src/components/AppMenu.tsx')} 菜单`,
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
