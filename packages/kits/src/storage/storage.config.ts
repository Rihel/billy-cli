import { z } from 'zod'

/** 对象存储组件配置（ObjectStorage 门面）：provider + 凭证 + 端点。 */
export const StorageConfigSchema = z.object({
  provider: z.enum(['s3', 'cos']).default('s3'),
  region: z.string().default('us-east-1'),
  bucket: z.string().default('billy-cli'),
  accessKeyId: z.string().default('minioadmin'),
  secretAccessKey: z.string().default('minioadmin'),
  endpoint: z.string().default('http://localhost:9000'),
})

export type StorageConfig = z.infer<typeof StorageConfigSchema>

/** DI 注入 token（StorageConfig 是纯类型，用 Symbol 作运行时标识） */
export const StorageConfig = Symbol.for('StorageConfig')
