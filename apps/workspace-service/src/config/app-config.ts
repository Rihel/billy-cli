import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  AppConfigFacade,
  DbConfigSchema,
  envConfigLoader,
  LoggerConfigSchema,
  WorkspaceConfigSchema,
} from '@repo/kits'

/**
 * workspace-service 的应用配置。
 *
 * 它是**执行面**：只读 `ai_workspaces` 的配置，管容器 / 沙箱的生命周期；
 * 不写表、不持有 provider key。
 */
export const workspaceServiceAppConfigSchema = z.object({
  server: z.object({
    port: z.coerce.number().int().positive().default(9995),
  }),
  logger: LoggerConfigSchema,
  db: DbConfigSchema,
  /** local 后端的沙箱配置（复用 kits 的 L1 沙箱） */
  workspace: WorkspaceConfigSchema,
  service: z.object({
    /** 内部令牌：main / 执行面之间；生产必须显式配置 */
    internalToken: z.string().min(1).default('dev-workspace-token'),
    /** 容器后端的默认镜像（workspace.image 为空时回退） */
    defaultImage: z.string().min(1).default('billy-workspace:latest'),
    /** 容器后端：docker（单机 / compose）或 kubernetes（云端多租户，走 kubectl） */
    containerRuntime: z.enum(['docker', 'kubernetes']).default('docker'),
    /** docker CLI 路径（docker 后端） */
    dockerBin: z.string().min(1).default('docker'),
    /** kubectl 路径（kubernetes 后端） */
    kubectlBin: z.string().min(1).default('kubectl'),
    /** workspace Pod 所在命名空间 */
    k8sNamespace: z.string().min(1).default('billy'),
    containerMemory: z.string().min(1).default('2g'),
    containerCpus: z.string().min(1).default('2'),
    containerPidsLimit: z.coerce.number().int().positive().default(512),
    /**
     * 空闲多久回收容器（默认 2 小时）。
     * `0` = **不回收**（容器常驻，直到用户手动停止/删除）——本地联调或需要长驻工作区时用。
     */
    idleTimeoutMs: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(2 * 60 * 60 * 1000),
    /** 回收扫描间隔 */
    reapIntervalMs: z.coerce.number().int().positive().default(60_000),
    /** local 后端的工作区根 */
    localRoot: z.string().min(1).default(join(tmpdir(), 'billy-workspaces')),
    /** 能力网关地址；配了才登记 bash / file 能力 */
    gatewayUrl: z.string().url().optional(),
    /** 实例 id（多副本时必须唯一） */
    instanceId: z.string().min(1).default(`${hostname()}-${process.pid}`),
    /** 本服务对外地址（网关回连 /invoke 用） */
    endpoint: z.string().url().default('http://127.0.0.1:9995'),
    /** 网关调用的内部令牌（与 internalToken 同源） */
    gatewayToken: z.string().min(1).optional(),
  }),
})

export type WorkspaceServiceAppConfig = z.infer<typeof workspaceServiceAppConfigSchema>
export const WorkspaceServiceConfig = Symbol.for('WorkspaceServiceConfig')
export type WorkspaceServiceConfigValue = WorkspaceServiceAppConfig['service']

const optional = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value

const parseBoolean = (value: string | undefined): boolean | undefined =>
  value === undefined || value === '' ? undefined : value !== 'false'

export const mapWorkspaceServiceEnv = (env: NodeJS.ProcessEnv): Record<string, unknown> => ({
  server: {
    port: optional(env.WORKSPACE_SERVICE_PORT) ?? optional(env.PORT),
  },
  logger: {
    prefix: optional(env.LOG_PREFIX) ?? 'workspace-service',
    level: optional(env.LOG_LEVEL),
    pretty: parseBoolean(env.LOG_PRETTY),
  },
  db: {
    url: optional(env.WORKSPACE_DB_URL) ?? optional(env.DB_URL),
    poolSize: optional(env.DB_POOL_SIZE),
  },
  workspace: {
    mode: optional(env.AGENT_WORKSPACE_MODE),
    sandboxNetwork: optional(env.AGENT_WORKSPACE_SANDBOX_NETWORK),
    probeTimeoutMs: optional(env.AGENT_WORKSPACE_PROBE_TIMEOUT_MS),
  },
  service: {
    internalToken: optional(env.WORKSPACE_INTERNAL_TOKEN),
    defaultImage: optional(env.WORKSPACE_DEFAULT_IMAGE),
    containerRuntime: optional(env.WORKSPACE_CONTAINER_RUNTIME),
    dockerBin: optional(env.WORKSPACE_DOCKER_BIN),
    kubectlBin: optional(env.WORKSPACE_KUBECTL_BIN),
    k8sNamespace: optional(env.WORKSPACE_K8S_NAMESPACE),
    containerMemory: optional(env.WORKSPACE_CONTAINER_MEMORY),
    containerCpus: optional(env.WORKSPACE_CONTAINER_CPUS),
    containerPidsLimit: optional(env.WORKSPACE_CONTAINER_PIDS_LIMIT),
    idleTimeoutMs: optional(env.WORKSPACE_IDLE_TIMEOUT_MS),
    reapIntervalMs: optional(env.WORKSPACE_REAP_INTERVAL_MS),
    localRoot: optional(env.WORKSPACE_LOCAL_ROOT),
    gatewayUrl: optional(env.WORKSPACE_GATEWAY_URL) ?? optional(env.TOOL_GATEWAY_URL),
    instanceId: optional(env.WORKSPACE_INSTANCE_ID),
    endpoint: optional(env.WORKSPACE_SERVICE_ENDPOINT),
    gatewayToken: optional(env.TOOL_INTERNAL_TOKEN),
  },
})

export const loadWorkspaceServiceAppConfig = (): Promise<WorkspaceServiceAppConfig> =>
  AppConfigFacade.initial({
    schema: workspaceServiceAppConfigSchema,
    loader: envConfigLoader({ envFileName: '.env', mapEnv: mapWorkspaceServiceEnv }),
  })
