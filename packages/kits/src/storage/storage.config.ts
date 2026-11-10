import { z } from 'zod'

/** 对象存储组件配置（ObjectStorage 统一入口）：provider + 凭证 + 端点。 */
export const StorageConfigSchema = z.object({
  provider: z.enum(['s3', 'cos']).default('s3'),
  region: z.string().default('us-east-1'),
  bucket: z.string().default('billy-cli'),
  accessKeyId: z.string().default('minioadmin'),
  secretAccessKey: z.string().default('minioadmin'),
  /**
   * S3 / MinIO 的端点。**不设默认值**：没配 = 对象存储未启用，
   * 服务照常启动，只有真正调用存储能力时才报「未配置或不可用」。
   *
   * 早先默认 `http://localhost:9000` 会造成两个问题：没部署 MinIO 的环境启动即失败；
   * 本地起服务时又悄悄连到本机 9000，把「没配」伪装成「配了但连不上」。
   * COS 走 bucket + region，不需要这个字段。
   */
  endpoint: z.string().trim().min(1).optional(),
})

export type StorageConfig = z.infer<typeof StorageConfigSchema>

/** DI 注入 token（StorageConfig 是纯类型，用 Symbol 作运行时标识） */
export const StorageConfig = Symbol.for('StorageConfig')
