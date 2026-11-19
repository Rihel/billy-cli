import { scanCapabilities, type ServiceDefinition } from '@repo/capability'

/** workspace-service 的登记清单：一个进程 = 一个服务 `workspace` */
export const WORKSPACE_SERVICE = {
  service: 'workspace',
  title: '工作空间执行',
  description: 'bash（以及后续 file）在工作区里执行',
  owner: '平台组',
} as const

export const buildWorkspaceService = (executors: readonly object[]): ServiceDefinition => ({
  ...WORKSPACE_SERVICE,
  capabilities: executors.flatMap((executor) =>
    scanCapabilities(executor).map((scanned) => scanned.decl),
  ),
})
