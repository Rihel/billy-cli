import { select, input, confirm } from '@inquirer/prompts'
import type { CrudField, Template } from '../types.js'
import { renderFile } from './utils.js'

/** 交互式收集 CRUD 字段定义 */
async function collectCrudFields(
  moduleName: string,
): Promise<CrudField[]> {
  // 非 TTY（自动化 / CI）场景：直接使用默认字段，避免交互挂起
  if (!process.stdin.isTTY) {
    return [
      { name: 'name', type: 'string', required: true, searchable: true },
      { name: 'description', type: 'text', required: false, searchable: true },
      { name: 'sort', type: 'number', required: false, searchable: false },
    ]
  }

  const useJson = await confirm({
    message: `是否以 JSON 数组方式定义字段？（否则逐步定义）`,
    default: true,
  })

  if (useJson) {
    const defaultFields = JSON.stringify(
      [
        { name: 'name', type: 'string', required: true, searchable: true },
        { name: 'description', type: 'text', required: false, searchable: true },
        { name: 'sort', type: 'number', required: false, searchable: false },
      ],
      null,
      2,
    )
    const raw = await input({
      message: `请粘贴 ${moduleName} 的字段定义（JSON 数组）：`,
      default: defaultFields,
      validate: (value: string) => {
        try {
          const parsed = JSON.parse(value)
          if (!Array.isArray(parsed)) return '必须是数组'
          for (const f of parsed) {
            if (!f.name || !f.type) return '每个字段必须有 name 和 type'
            if (!['string', 'number', 'boolean', 'text'].includes(f.type)) {
              return `不支持的字段类型：${f.type}`
            }
          }
          return true
        } catch {
          return 'JSON 格式无效'
        }
      },
    })
    return JSON.parse(raw) as CrudField[]
  }

  // 逐步定义
  const fields: CrudField[] = []
  let addMore = true
  while (addMore) {
    const name = await input({
      message: '字段名（小驼峰，如 fieldName）：',
      validate: (v: string) => (v ? true : '字段名不能为空'),
    })

    const type = await select<string>({
      message: '字段类型：',
      choices: [
        { name: '字符串 string', value: 'string' },
        { name: '数字 number', value: 'number' },
        { name: '布尔 boolean', value: 'boolean' },
        { name: '长文本 text', value: 'text' },
      ],
    })

    const required = await confirm({
      message: '是否必填？',
      default: false,
    })

    const searchable = await confirm({
      message: '是否支持搜索？',
      default: type === 'string' || type === 'text',
    })

    const isUnique = await confirm({
      message: '是否唯一约束？',
      default: false,
    })

    fields.push({ name, type: type as CrudField['type'], required, searchable, unique: isUnique })

    addMore = await confirm({ message: '继续添加字段？', default: false })
  }
  return fields
}

/** 简单复数化表名（todos / products / categories / boxes） */
function pluralize(word: string): string {
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`
  return `${word}s`
}

function snakeCase(str: string): string {
  return str.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)
}

/** 单个字段的 TypeORM 列定义（2 空格缩进 + 换行，参考 todo-entity.ts） */
function renderColumn(f: CrudField): string {
  const colName = snakeCase(f.name)
  const unique = f.unique ? ', unique: true' : ''
  switch (f.type) {
    case 'boolean':
      return `  @Column({ name: '${colName}', type: 'boolean', default: false })\n  ${f.name} = false\n`
    case 'number':
      return f.required
        ? `  @Column({ name: '${colName}', type: 'int'${unique} })\n  ${f.name}!: number\n`
        : `  @Column({ name: '${colName}', type: 'int', nullable: true${unique} })\n  ${f.name}: number | null = null\n`
    default:
      return f.required
        ? `  @Column({ name: '${colName}', type: 'text'${unique} })\n  ${f.name}!: string\n`
        : `  @Column({ name: '${colName}', type: 'text', nullable: true${unique} })\n  ${f.name}: string | null = null\n`
  }
}

/** 单个字段的 Zod 类型表达式 */
function renderFieldType(f: CrudField): string {
  switch (f.type) {
    case 'string':
      // 非必填 string 在实体中是 `string | null`，schema 需含 nullable
      return f.required ? 'z.string()' : 'z.string().nullable().optional()'
    case 'text':
      return f.required ? 'z.string()' : 'z.string().nullable().optional()'
    case 'number':
      // 非必填 number 在实体中是 `number | null`，schema 需含 nullable
      return f.required ? 'z.number()' : 'z.number().nullable().optional()'
    case 'boolean':
      return 'z.boolean().default(false)'
    default:
      return 'z.string()'
  }
}

/** 搜索条件片段（repository 的 page / cursor 共用；4 空格缩进） */
function renderSearchCondition(name: string, fields: CrudField[]): string {
  const searchable = fields.filter((f) => f.searchable)
  if (searchable.length === 0) return ''
  const alias = name.charAt(0)
  const conditions = searchable
    .map((f) => `${alias}.${f.name} ILIKE :keyword`)
    .join(' OR ')
  const where = searchable.length > 1 ? `(${conditions})` : conditions
  return `    if (keyword) {
      builder.andWhere('${where}', { keyword: '%' + keyword + '%' })
    }`
}

/** 生成 TypeORM 实体（files/crud/entity.eta） */
function renderEntity(name: string, fields: CrudField[]): string {
  return renderFile('crud/entity', {
    name,
    modulePascal: name.charAt(0).toUpperCase() + name.slice(1),
    tableName: pluralize(snakeCase(name)),
    columns: fields.map(renderColumn).join(''),
  })
}

/** 生成 Zod schema（files/crud/schema.eta） */
function renderSchema(name: string, fields: CrudField[]): string {
  const modulePascal = name.charAt(0).toUpperCase() + name.slice(1)

  // 带默认值的字段（boolean）在 create 时省略
  const defaultedFields = fields.filter((f) => f.type === 'boolean')
  const omitClause =
    defaultedFields.length > 0
      ? `.omit({ ${defaultedFields.map((f) => `${f.name}: true`).join(', ')} })`
      : ''

  // 可排序字段：时间字段在前，业务字段在后
  const orderableFields = fields
    .filter((f) => f.type === 'string' || f.type === 'number')
    .map((f) => f.name)
  orderableFields.unshift('updatedAt', 'createdAt')

  return renderFile('crud/schema', {
    name,
    modulePascal,
    fieldShapeLines: fields
      .map((f) => `  ${f.name}: ${renderFieldType(f)},`)
      .join('\n'),
    omitClause,
    orderableFields: orderableFields.join("', '"),
  })
}

/** 生成 repository（files/crud/repository.eta） */
function renderRepository(name: string, fields: CrudField[]): string {
  const modulePascal = name.charAt(0).toUpperCase() + name.slice(1)
  return renderFile('crud/repository', {
    name,
    modulePascal,
    entityPascal: modulePascal + 'Entity',
    alias: name.charAt(0),
    searchCondition: renderSearchCondition(name, fields),
  })
}

/** 生成 service（files/crud/service.eta） */
function renderService(name: string): string {
  return renderFile('crud/service', {
    name,
    modulePascal: name.charAt(0).toUpperCase() + name.slice(1),
  })
}

/** 生成模块错误（files/crud/errors.eta） */
function renderErrors(name: string): string {
  return renderFile('crud/errors', {
    name,
    modulePascal: name.charAt(0).toUpperCase() + name.slice(1),
  })
}

/** 生成模块 index.ts 聚合导出（files/crud/index.eta） */
function renderModule(name: string): string {
  return renderFile('crud/index', { name })
}

/** 生成 Hono 路由（files/crud/features.eta） */
function renderRoutes(name: string): string {
  return renderFile('crud/features', {
    name,
    modulePascal: name.charAt(0).toUpperCase() + name.slice(1),
  })
}

/** 交互式收集字段并生成 CRUD 模板 */
export async function createCrudTemplate(name: string): Promise<Template> {
  const modulePascal = name.charAt(0).toUpperCase() + name.slice(1)

  console.log(`\n📝 现在定义 ${modulePascal} 的字段：`)
  const fields = await collectCrudFields(name)

  return {
    directory: 'apps/server/src/modules',
    files: {
      'errors.ts': renderErrors(name),
      [`${name}.repository.ts`]: renderRepository(name, fields),
      [`${name}.service.ts`]: renderService(name),
      'index.ts': renderModule(name),
    },
    extraFiles: {
      [`apps/server/src/database/entities/${name}-entity.ts`]: renderEntity(name, fields),
      [`apps/server/src/features/${name}.ts`]: renderRoutes(name),
      [`packages/shared/src/schema/${name}.schema.ts`]: renderSchema(name, fields),
    },
  }
}
