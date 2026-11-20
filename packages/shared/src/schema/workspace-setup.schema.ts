import { z } from 'zod'

/**
 * 初始化清单（`docs/design/workspace-cli-credentials.md` §6.2）。
 *
 * 这里存的是**声明**：需要哪些 CLI、什么版本、配了什么；
 * 装好的二进制不属于资产，由声明在工作区里重放生成。
 */

/** 安装管理器：镜像里已把 apt / pip / uv / npm / pnpm 指向国内源 */
export const WorkspaceSetupManagerSchema = z.enum(['npm', 'pnpm', 'apt', 'pip', 'uv'])

/**
 * 一个安装项。
 *
 * - `spec` **必须锁版本**（`@larksuite/cli@1.2.3` / `redis-tools=7:7.0.15`），否则声明不可重放；
 * - `verify` 必填：装完执行一次，失败即记录明确原因；
 * - `cli` 指向代码里的适配器（无适配器的包也能装，只是缺命令识别与凭据预检）。
 */
export const WorkspaceSetupPackageSchema = z.object({
  manager: WorkspaceSetupManagerSchema,
  spec: z.string().min(1).max(200),
  verify: z.string().min(1).max(200),
  cli: z.string().min(1).max(64).optional(),
})
export type WorkspaceSetupPackage = z.infer<typeof WorkspaceSetupPackageSchema>

/** 非凭据配置文件（声明层资产）：初始化时原样写进工作区 */
export const WorkspaceSetupFileSchema = z.object({
  path: z.string().min(1).max(512),
  content: z.string().max(64 * 1024),
})
export type WorkspaceSetupFile = z.infer<typeof WorkspaceSetupFileSchema>

/** 初始化清单模型（不含密文：凭据走 `personal_credentials`） */
export const WorkspaceSetupSchema = z.object({
  id: z.string(),
  ownerType: z.enum(['user', 'admin']),
  ownerId: z.string(),
  name: z.string(),
  packages: z.array(WorkspaceSetupPackageSchema),
  files: z.array(WorkspaceSetupFileSchema),
  env: z.record(z.string(), z.string()),
  status: z.enum(['active', 'disabled']),
  createdAt: z.union([z.string(), z.date()]).optional(),
  updatedAt: z.union([z.string(), z.date()]).optional(),
})
export type WorkspaceSetupModel = z.infer<typeof WorkspaceSetupSchema>

/** 工作区对清单的引用（`setupId` 为空 = 用 owner 的 `default` 清单；`setupExtra` 只作用于本工作区） */
export const WorkspaceSetupRefSchema = z.object({
  setupId: z.string().nullable(),
  setupExtra: z.array(WorkspaceSetupPackageSchema),
})
export type WorkspaceSetupRef = z.infer<typeof WorkspaceSetupRefSchema>

/** 初始化报告（回传会话 / 排障用；不含凭据值） */
export const WorkspaceSetupReportSchema = z.object({
  setupId: z.string(),
  hash: z.string(),
  durationMs: z.number().int().nonnegative(),
  packages: z.array(
    z.object({
      spec: z.string(),
      outcome: z.enum(['installed', 'skipped', 'failed', 'timeout']),
      message: z.string().optional(),
    }),
  ),
  skills: z.array(
    z.object({
      skillKey: z.string(),
      outcome: z.enum(['materialized', 'failed']),
      message: z.string().optional(),
    }),
  ),
  credentials: z.array(
    z.object({
      name: z.string(),
      outcome: z.enum(['materialized', 'skipped', 'denied', 'failed']),
      message: z.string().optional(),
    }),
  ),
})
export type WorkspaceSetupReport = z.infer<typeof WorkspaceSetupReportSchema>
