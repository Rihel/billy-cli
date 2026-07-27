import { select, input, confirm } from '@inquirer/prompts'
import type { CrudField, Template } from '../types.js'
import { source } from './utils.js'

/** 交互式收集 CRUD 字段定义 */
async function collectCrudFields(
  moduleName: string,
): Promise<CrudField[]> {
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

/** 根据字段列表生成 drizzle-orm entity 代码片段 */
function renderEntity(name: string, fields: CrudField[]): string {
  const moduleName = name
  const tableName = snakeCase(moduleName)

  const columnLines = fields.map((f) => {
    const colName = snakeCase(f.name)
    switch (f.type) {
      case 'string':
        return `  ${f.name}: text('${colName}')${f.required ? '.notNull()' : ''}${f.unique ? '.unique()' : ''},`
      case 'text':
        return `  ${f.name}: text('${colName}'),`
      case 'number':
        return `  ${f.name}: numeric('${colName}')${f.required ? '.notNull()' : ''},`
      case 'boolean':
        return `  ${f.name}: boolean('${colName}')${f.required ? '.notNull()' : ''}.default(false),`
      default:
        return `  ${f.name}: text('${colName}'),`
    }
  })

  return source`
export const ${moduleName} = snakeCase.table(
  '${tableName}',
  {
    ...commonColumns,
${columnLines.join('\n')}
  },
  (table: any) => [
    index('${tableName}_updated_at_id_idx').on(table.updatedAt.desc(), table.id.desc()),
  ],
)
`
}

function snakeCase(str: string): string {
  return str.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)
}

/** 根据字段列表生成 Zod schema 代码 */
function renderSchema(name: string, fields: CrudField[]): string {
  const modulePascal = name.charAt(0).toUpperCase() + name.slice(1)
  const fieldShapeLines = fields.map((f) => {
    let zodType: string
    switch (f.type) {
      case 'string':
        zodType = 'z.string()'
        break
      case 'text':
        zodType = 'z.string()'
        break
      case 'number':
        zodType = 'z.number()'
        break
      case 'boolean':
        zodType = 'z.boolean()'
        break
      default:
        zodType = 'z.string()'
    }
    if (f.required) {
      return `  ${f.name}: ${zodType},`
    }
    return `  ${f.name}: ${zodType}.optional(),`
  })

  const searchableFields = fields
    .filter((f) => f.searchable)
    .map((f) => {
      switch (f.type) {
        case 'number':
          return `ilike(${name}.${f.name}, \`%\${input.keyword}%\`)`
        default:
          return `ilike(${name}.${f.name}, \`%\${input.keyword}%\`)`
      }
    })

  const searchCondition = searchableFields.length > 0
    ? `      where: keyword\n        ? or(\n${searchableFields.map((sf) => `            ${sf},\n`).join('')}        )\n        : undefined,`
    : '      where: keyword ? ilike(todos.title, `%${keyword}%`) : undefined,'

  // 对于 controller，选择 orderBy 字段
  const orderableFields = fields
    .filter((f) => f.type === 'string' || f.type === 'number')
    .map((f) => f.name)
  orderableFields.unshift('createdAt', 'updatedAt')

  return source`
import { z } from 'zod'
import {
  BaseCursorPaginateDto,
  BaseModel,
  BasePaginateDto,
} from './base.schema'

const ${modulePascal}Fields = z.object({
${fieldShapeLines.join('\n')}
})

export const ${modulePascal}Model = z.intersection(BaseModel, ${modulePascal}Fields)

export const ${modulePascal}IdInputDto = z.object({
  ${name}Id: z.string(),
})

export const Create${modulePascal}Dto = ${modulePascal}Fields

export const Update${modulePascal}Dto = ${modulePascal}Fields.extend(${modulePascal}IdInputDto.shape)

export const PageQuery${modulePascal}Dto = BasePaginateDto.extend({
  keyword: z.string().optional(),
  orderBy: z
    .enum(['${orderableFields.join("', '")}'])
    .optional()
    .default('createdAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
})

export const ${modulePascal}CursorDto = z.object({
  updatedAt: z.string().datetime(),
  ${name}Id: z.string(),
})

export const ${modulePascal}CursorModel = ${modulePascal}CursorDto

export const CursorQuery${modulePascal}Dto = BaseCursorPaginateDto.extend({
  cursor: ${modulePascal}CursorDto.optional(),
  keyword: z.string().optional(),
})
`
}

/** 根据字段列表生成 controller */
function renderController(name: string, fields: CrudField[]): string {
  const modulePascal = name.charAt(0).toUpperCase() + name.slice(1)

  return source`
import { Controller, Post, UseGuards, Inject } from '@nestjs/common';
import { ${modulePascal}Service } from './${name}.service.js';
import {
  Create${modulePascal}Dto,
  CursorQuery${modulePascal}Dto,
  PageQuery${modulePascal}Dto,
  ${modulePascal}IdInputDto,
  Update${modulePascal}Dto,
  ${modulePascal}Model,
} from '@repo/shared';
import type { z } from 'zod';
import { ZBody, ZSerialize } from 'nest-zod';
import { AuthGuard } from '../../guards/auth.guard.js';

@Controller('${name}')
@UseGuards(AuthGuard)
export class ${modulePascal}Controller {
  constructor(
    @Inject(${modulePascal}Service)
    private readonly ${name}Service: ${modulePascal}Service,
  ) {}

  @Post('create')
  @ZSerialize(${modulePascal}Model)
  create(@ZBody(Create${modulePascal}Dto) input: z.infer<typeof Create${modulePascal}Dto>) {
    return this.${name}Service.create(input);
  }

  @Post('find-many')
  findMany(
    @ZBody(PageQuery${modulePascal}Dto) input: z.infer<typeof PageQuery${modulePascal}Dto>,
  ) {
    return this.${name}Service.findMany(input);
  }

  @Post('find-many-cursor')
  findManyCursor(
    @ZBody(CursorQuery${modulePascal}Dto) input: z.infer<typeof CursorQuery${modulePascal}Dto>,
  ) {
    return this.${name}Service.findManyCursor(input);
  }

  @Post('find-by-id')
  findById(@ZBody(${modulePascal}IdInputDto) input: z.infer<typeof ${modulePascal}IdInputDto>) {
    return this.${name}Service.findById(input.${name}Id);
  }

  @Post('update')
  update(@ZBody(Update${modulePascal}Dto) input: z.infer<typeof Update${modulePascal}Dto>) {
    return this.${name}Service.update(input);
  }

  @Post('remove')
  remove(@ZBody(${modulePascal}IdInputDto) input: z.infer<typeof ${modulePascal}IdInputDto>) {
    return this.${name}Service.remove(input.${name}Id);
  }
}
`
}

/** 根据字段列表生成 service */
function renderService(name: string, fields: CrudField[]): string {
  const modulePascal = name.charAt(0).toUpperCase() + name.slice(1)
  const entityName = name

  const searchableFields = fields.filter((f) => f.searchable)

  let searchImport: string
  let findManyWhere: string
  let findManyCursorWhere: string

  if (searchableFields.length === 0) {
    searchImport = ''
    findManyWhere = 'const where = undefined;'
    findManyCursorWhere = 'undefined'
  } else if (searchableFields.length === 1) {
    const f = searchableFields[0]!
    searchImport = 'import { eq, ilike } from \'drizzle-orm\';'
    findManyWhere = `    const where = keyword ? ilike(${entityName}.${f.name}, \`%\${keyword}%\`) : undefined;`
    findManyCursorWhere = `keyword ? ilike(${entityName}.${f.name}, \`%\${keyword}%\`) : undefined`
  } else {
    searchImport = 'import { eq, ilike, or } from \'drizzle-orm\';'
    const conditions = searchableFields
      .map((f) => `ilike(${entityName}.${f.name}, \`%\${keyword}%\`)`)
      .join(',\n          ')
    findManyWhere = `    const where = keyword\n      ? or(\n          ${conditions},\n        )\n      : undefined;`
    findManyCursorWhere = `keyword\n        ? or(\n          ${conditions},\n        )\n        : undefined`
  }

  const orderableFields = fields
    .filter((f) => f.type === 'string' || f.type === 'number' || f.name === 'sort')
    .map((f) => `'${f.name}'`)
  orderableFields.unshift("'updatedAt'", "'createdAt'")

  return source`
import { Injectable } from '@nestjs/common';
import { ${entityName} } from '@repo/db';
import {
  AppErrorCodes,
  Create${modulePascal}Dto,
  CursorQuery${modulePascal}Dto,
  PageQuery${modulePascal}Dto,
  Update${modulePascal}Dto,
} from '@repo/shared';
${searchImport ? '\n' + searchImport : ''}
import { PgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { AppError, AppLoggerService, DbService } from '@repo/kits';

@Injectable()
export class ${modulePascal}Service {
  constructor(
    private db: DbService,
    private logger: AppLoggerService,
  ) {}

  async create(input: z.infer<typeof Create${modulePascal}Dto>) {
    this.logger.log('create', input);
    const [record] = await this.db.insert(${entityName}).values(input).returning();
    this.logger.log('created', { id: record.id });
    return record;
  }

  async findMany(input: z.infer<typeof PageQuery${modulePascal}Dto>) {
    this.logger.log('findMany', input);
    const { page, size, keyword, orderBy, order } = input;
${findManyWhere}
    const result = await this.db.paginate({
      table: ${entityName},
      where,
      orderCol: ${entityName}[orderBy as keyof typeof ${entityName}] as PgColumn,
      order,
      page,
      size,
    });
    this.logger.log('findMany result', { total: result.total, page, size });
    return result;
  }

  async findManyCursor(input: z.infer<typeof CursorQuery${modulePascal}Dto>) {
    const { cursor, keyword, size } = input;
    return this.db.paginateCursor({
      table: ${entityName},
      cursorColumns: [${entityName}.updatedAt, ${entityName}.id],
      cursorValues: cursor
        ? [new Date(cursor.updatedAt), cursor.${name}Id]
        : undefined,
      getCursor: (item: any) => ({
        updatedAt: item.updatedAt.toISOString(),
        ${name}Id: item.id,
      }),
      where: ${findManyCursorWhere},
      size,
    });
  }

  async findById(${name}Id: string) {
    this.logger.log('findById', { ${name}Id });
    const [record] = await this.db
      .select()
      .from(${entityName})
      .where(eq(${entityName}.id, ${name}Id));
    if (!record) {
      this.logger.warn('findById not found', { ${name}Id });
      throw new AppError(AppErrorCodes.${modulePascal}NotFound);
    }
    return record;
  }

  async update(input: z.infer<typeof Update${modulePascal}Dto>) {
    this.logger.log('update', input);
    const { ${name}Id, ...fields } = input;
    const [record] = await this.db
      .update(${entityName})
      .set(fields)
      .where(eq(${entityName}.id, ${name}Id))
      .returning();
    if (!record) {
      this.logger.warn('update not found', { ${name}Id });
      throw new AppError(AppErrorCodes.${modulePascal}NotFound);
    }
    this.logger.log('updated', { id: record.id });
    return record;
  }

  async remove(${name}Id: string) {
    this.logger.log('remove', { ${name}Id });
    const [record] = await this.db
      .delete(${entityName})
      .where(eq(${entityName}.id, ${name}Id))
      .returning();
    if (!record) {
      this.logger.warn('remove not found', { ${name}Id });
      throw new AppError(AppErrorCodes.${modulePascal}NotFound);
    }
    this.logger.log('removed', { id: record.id });
    return record;
  }
}
`
}

/** 生成模块 index.ts */
function renderModule(name: string): string {
  const modulePascal = name.charAt(0).toUpperCase() + name.slice(1)
  return source`
import { Module } from '@nestjs/common';
import { ${modulePascal}Service } from './${name}.service.js';
import { ${modulePascal}Controller } from './${name}.controller.js';

@Module({
  controllers: [${modulePascal}Controller],
  providers: [${modulePascal}Service],
  exports: [${modulePascal}Service],
})
export class ${modulePascal}Module {}
`
}

/** 交互式收集字段并生成 CRUD 模板 */
export async function createCrudTemplate(name: string): Promise<Template> {
  const modulePascal = name.charAt(0).toUpperCase() + name.slice(1)

  console.log(`\n📝 现在定义 ${modulePascal} 的字段：`)
  const fields = await collectCrudFields(name)

  return {
    directory: 'apps',
    files: {
      [`src/modules/${name}/index.ts`]: renderModule(name),
      [`src/modules/${name}/${name}.controller.ts`]: renderController(name, fields),
      [`src/modules/${name}/${name}.service.ts`]: renderService(name, fields),
    },
    extraFiles: {
      [`packages/shared/src/schema/${name}.schema.ts`]: renderSchema(name, fields),
    },
  }
}

export const entitySnippet = renderEntity
