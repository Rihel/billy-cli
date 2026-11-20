import { z } from 'zod'

/**
 * 凭据解析的内部契约（`docs/design/workspace-cli-credentials.md` §6.4.6）。
 *
 * 调用方：能力网关（平台侧 MCP 按调用人取凭据）、workspace-service（初始化 / 同步落地）。
 * 归属主体由调用方明确传入（不是"当前登录人"），因此**必须走内部 token 鉴权**。
 */

/** 解析请求：按主体 + 凭据名批量取用 */
export const CredentialResolveRequestSchema = z.object({
  ownerType: z.enum(['user', 'admin']),
  ownerId: z.string().min(1).max(20),
  /** 凭据名（`personal_credentials.name`），不是 provider：同一 provider 可绑多个账号 */
  names: z.array(z.string().min(1).max(64)).min(1).max(20),
  /** 消费方标识（落审计用） */
  consumer: z.enum(['workspace-service', 'capability-gateway', 'web', 'main']),
  /** 关联到具体那次执行（落审计用） */
  requestId: z.string().max(64).optional(),
})
export type CredentialResolveRequest = z.infer<typeof CredentialResolveRequestSchema>

/**
 * 单条解析结果。
 *
 * `status` 在库里的取值（active / expired / revoked）之外多了 **`missing`**：
 * 请求了某个名字但库里没有这条记录。调用方据此区分"没绑定"与"绑定过但失效"，
 * 两者的用户提示不同（前者引导绑定，后者引导重新授权）。
 */
export const CredentialResolvedItemSchema = z.object({
  name: z.string(),
  provider: z.string(),
  status: z.enum(['active', 'expired', 'revoked', 'missing']),
  /** 到期时间（ISO 字符串）；`null` 表示长期凭据或未登记 */
  expiresAt: z.string().nullable(),
  /** 密文字段解出来的明文（失效 / 缺失时为 null） */
  secret: z.record(z.string(), z.unknown()).nullable(),
  /** 明文配置（host / port / region 等） */
  config: z.record(z.string(), z.unknown()),
  /** 注入规则（文件 / 环境变量） */
  inject: z.array(z.unknown()),
  /** 失败原因（中文，便于直接转述给用户；不含凭据值） */
  message: z.string().optional(),
})
export type CredentialResolvedItem = z.infer<typeof CredentialResolvedItemSchema>

/** 工作区导入：解析后的值交给 main 加密入库（值只走内部通道，不回显） */
export const CredentialImportRequestSchema = z.object({
  ownerType: z.enum(['user', 'admin']),
  ownerId: z.string().min(1).max(20),
  provider: z.string().min(1).max(32),
  name: z.string().trim().min(1).max(64).optional(),
  template: z.string().min(1).max(32).optional(),
  values: z.record(z.string(), z.unknown()),
  lifetime: z.enum(['long-term', 'temporary']).optional(),
  expiresAt: z.string().optional(),
})
export type CredentialImportRequest = z.infer<typeof CredentialImportRequestSchema>

export const CredentialImportResponseSchema = z.object({
  credential: z.object({
    id: z.string(),
    name: z.string(),
    provider: z.string(),
    status: z.string(),
    /** 导入后有没有用适配器的 status 命令验证过（true=验证通过；undefined=该适配器无 status） */
    verified: z.boolean().optional(),
  }),
})
export type CredentialImportResponse = z.infer<typeof CredentialImportResponseSchema>

export const CredentialResolveResponseSchema = z.object({
  items: z.array(CredentialResolvedItemSchema),
})
export type CredentialResolveResponse = z.infer<typeof CredentialResolveResponseSchema>
