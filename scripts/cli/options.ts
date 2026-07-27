import { confirm, input, select } from '@inquirer/prompts'
import { Command, InvalidArgumentError, Option } from 'commander'
import { templateLabels } from './templates/index.js'
import { templateTypes } from './types.js'
import type { CliOptions, TemplateType } from './types.js'

function parseTemplateType(value: string): TemplateType {
  if (!templateTypes.includes(value as TemplateType)) {
    throw new InvalidArgumentError('可选值为 package、client、service 或 crud')
  }
  return value as TemplateType
}

export function parseOptions(): CliOptions {
  const program = new Command()
    .name('pnpm create:workspace')
    .description('交互式生成 monorepo workspace 模板')
    .addOption(
      new Option('-t, --type <type>', '模板类型').argParser(parseTemplateType),
    )
    .option('-n, --name <name>', '项目名称')
    .option('--install', '生成后安装依赖')
    .option('--no-install', '生成后不安装依赖')
    .helpOption('-h, --help', '显示帮助')
    .showHelpAfterError()

  program.parse()
  return program.opts<CliOptions>()
}

function validateName(name: string): string | undefined {
  if (!name) return '名称不能为空'
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    return '名称必须以小写字母开头，且只能包含小写字母、数字和连字符'
  }
  return undefined
}

export async function collectOptions(
  options: CliOptions,
): Promise<Required<CliOptions>> {
  const type =
    options.type ??
    (await select<TemplateType>({
      message: '请选择要生成的模板',
      choices: Object.entries(templateLabels).map(([value, name]) => ({
        value: value as TemplateType,
        name,
      })),
    }))

  const name = (
    options.name ??
    (await input({
      message: '项目名称',
      validate: (value) => validateName(value.trim()) ?? true,
    }))
  ).trim()
  const nameError = validateName(name)
  if (nameError) throw new Error(nameError)

  const install =
    options.install ??
    (await confirm({
      message: '生成后执行 pnpm install？',
      default: true,
    }))

  return { type, name, install }
}