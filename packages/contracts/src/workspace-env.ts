import { z } from 'zod'

/**
 * **执行环境声明**（`docs/design/workspace-env-contract.md`）。
 *
 * 一个工作区跑在什么环境里，由两部分描述：
 * 1. **坐标**：工作区配置里的 `backend` + `location`（local 的目录 / 容器的镜像）；
 * 2. **声明**：这份数据 —— 环境有哪些能力，上层（工具、初始化、提示词、后台）按它做事。
 *
 * 为什么单独一份而不是散在 `if (backend)` 里：同一个动作在不同环境里语义不同
 * （能不能写 HOME、有没有资源限额、停止后数据还在不在），散着写必然漂移；
 * 声明是唯一事实源，工具只读它，不读 backend。
 */
/**
 * 执行驱动：`host`（本机进程 + 沙箱）/ `container`（Docker 容器）/ `pod`（Kubernetes Pod）。
 *
 * 一个字段说清「这个工作区跑在哪」，不再另设 backend 与容器运行时两个变量。
 */
export const WorkspaceDriverKindSchema = z.enum(['host', 'container', 'pod'])
export type WorkspaceDriverKind = z.infer<typeof WorkspaceDriverKindSchema>

export const WorkspaceShellSchema = z.enum(['sh', 'cmd'])
export type WorkspaceShell = z.infer<typeof WorkspaceShellSchema>

/** 隔离档位：系统沙箱 / 受限用户 + 目录权限 / 无隔离 */
export const WorkspaceSandboxSchema = z.enum(['os', 'restricted-user', 'none'])
export type WorkspaceSandbox = z.infer<typeof WorkspaceSandboxSchema>

/** 命令默认能不能出网：断网 / 可出网 / 按配置（容器 bridge 或 none） */
export const WorkspaceNetworkSchema = z.enum(['deny', 'allow', 'configurable'])
export type WorkspaceNetwork = z.infer<typeof WorkspaceNetworkSchema>

/** 停止后数据还在不在 */
export const WorkspacePersistenceSchema = z.enum(['durable', 'ephemeral'])
export type WorkspacePersistence = z.infer<typeof WorkspacePersistenceSchema>

export const WorkspaceFeaturesSchema = z.object({
  /** 整条命令由谁解释：`sh` = Linux/macOS 的 `/bin/sh`；`cmd` = Windows cmd.exe */
  shell: WorkspaceShellSchema,
  /** 隔离档位；`none` 时命令以服务进程身份执行，没有系统边界 */
  sandbox: WorkspaceSandboxSchema,
  /** 命令默认能不能出网 */
  network: WorkspaceNetworkSchema,
  /** 能不能往用户 HOME 写文件（决定凭据落地方式） */
  writeHome: z.boolean(),
  /** 能不能装全局包（决定安装清单是「装」还是「只检查」） */
  installGlobal: z.boolean(),
  /** 停止后数据是否保留 */
  persistence: WorkspacePersistenceSchema,
  /** 有没有内存 / CPU / 进程数限额（没有则由上层兜底） */
  resourceLimits: z.boolean(),
  /** 能否提供工作区外的只读目录（技能目录） */
  extraReadRoots: z.boolean(),
  /** 是否支持多副本 */
  multiInstance: z.boolean(),
})
export type WorkspaceFeatures = z.infer<typeof WorkspaceFeaturesSchema>

/** 查询某个工作区的执行环境声明（提示词 / 后台展示用；不产生副作用） */
export const WorkspaceEnvironmentRequestSchema = z.object({
  workspaceId: z.string().min(1).max(64),
})
export type WorkspaceEnvironmentRequest = z.infer<typeof WorkspaceEnvironmentRequestSchema>

export const WorkspaceEnvironmentSchema = z.object({
  workspaceId: z.string(),
  backend: z.enum(['local', 'container', 'microvm']),
  /** 工作区根：Host = 宿主目录；容器 = `/workspace` */
  root: z.string(),
  /** 根是否由平台托管（false = 用户指定的目录） */
  managed: z.boolean(),
  /** 这个工作区实际用哪个驱动：host / docker / kubernetes */
  driver: WorkspaceDriverKindSchema,
  /** 工作区文件权限（提示词里告诉模型能不能写） */
  fileAccess: z.enum(['read-only', 'write']),
  features: WorkspaceFeaturesSchema,
})
export type WorkspaceEnvironment = z.infer<typeof WorkspaceEnvironmentSchema>
