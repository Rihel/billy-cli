import { z } from 'zod'

/**
 * 数据库组件配置（Db 门面）：连接串 / 同步建表 / 实体注入。
 * 实体由应用层注入（kits 不持有任何业务实体），schema 校验在装配时执行。
 */
export const DbConfigSchema = z.object({
  url: z
    .string()
    .default('postgres://postgres:postgres@localhost:5432/postgres'),
  sync: z.boolean().default(false),
  /** 运行时实体类构造器数组（应用层注入，供 createDb 注册） */
  entities: z.array(z.unknown()).optional(),
})

export type DbConfig = z.infer<typeof DbConfigSchema>

/** DI 注入 token（DbConfig 是纯类型，用 Symbol 作运行时标识） */
export const DbConfig = Symbol.for('DbConfig')
