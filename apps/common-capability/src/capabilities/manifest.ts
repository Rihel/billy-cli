import { scanCapabilities, type ServiceDefinition } from '@repo/capability'

/**
 * common-capability 的登记清单：**一个进程 = 一个服务** `common`。
 *
 * bash / web / files / memory 只是代码内的能力分组（各执行器类），不是服务身份：
 * 它们背后是同一个进程、同一份部署、同一个责任团队，拆成四行只会让后台出现四条「假服务」，
 * 启停 / 凭据 / 探活都要按四份维护。安全边界在**能力级**的 risk / scope 声明里已经够了。
 *
 * 能力从执行器的装饰器声明扫描聚合（`scanCapabilities`），不再手工维护 key 列表：
 * 加一个能力 = 给执行器加一个 `@CapabilityDecl` 方法。
 */
export const COMMON_SERVICE = {
  service: 'common',
  title: '通用能力',
  description: 'bash / web / files / memory 四组通用能力，同进程登记为一个服务',
  owner: '平台组',
} as const

/** 执行器实例 → 服务定义（能力按各执行器的声明顺序聚合） */
export const buildCommonService = (executors: readonly object[]): ServiceDefinition => ({
  ...COMMON_SERVICE,
  capabilities: executors.flatMap((executor) =>
    scanCapabilities(executor).map((scanned) => scanned.decl),
  ),
})
