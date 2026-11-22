import type {
  WorkspaceConfig,
  WorkspaceExecRequest,
  WorkspaceExecResult,
  WorkspaceFeatures,
  WorkspaceFsRequest,
  WorkspaceFsResult,
} from '@repo/contracts'

/**
 * **工作区驱动**（`docs/design/workspace-env-contract.md` §3）。
 *
 * 驱动只回答「**怎么做**」：起停、执行一条命令、一组文件原语、探测、释放。
 * 「做什么」（工具语义、初始化策略、锁与回收）在执行面，驱动不认识它们。
 *
 * 三种实现：`host`（宿主进程 + 沙箱）/ `docker` / `kubernetes`。
 * 形状是接口而不是基类：容器专属字段（容器名、命名空间）留在实现与 `ref` 里，
 * 不让它们漏进公共类型。
 */
export interface DriverRef {
  workspaceId: string
  /** 工作区根：Host = 宿主路径；容器 = `/workspace` */
  root: string
  /** 根是否由平台托管（false = 用户指定的目录） */
  managed: boolean
  /** 容器名（仅容器驱动认识；Host 为空） */
  containerName?: string
}

export type DisposeMode = 'stop' | 'purge'

export interface WorkspaceDriver {
  readonly kind: 'host' | 'docker' | 'kubernetes'
  /** 只读探测：可用性 + 原因（沙箱不可用 / daemon 连不上），不产生副作用 */
  probe(): Promise<{ available: boolean; reason?: string }>
  /**
   * 准备环境（幂等）：建目录 / 校验结果由调用方的坐标解析负责，这里做「起容器 / 建目录」。
   * `started` 表示这次是否**新建**了环境（决定要不要跑完整初始化）。
   */
  prepare(ref: DriverRef, config: WorkspaceConfig): Promise<{ ref: DriverRef; started: boolean }>
  exec(
    ref: DriverRef,
    config: WorkspaceConfig,
    request: WorkspaceExecRequest,
  ): Promise<WorkspaceExecResult>
  fs(ref: DriverRef, request: WorkspaceFsRequest): Promise<WorkspaceFsResult>
  /** `stop` = 释放运行环境（数据由 `persistence` 决定留不留）；`purge` = 连数据一起删 */
  dispose(ref: DriverRef, mode: DisposeMode): Promise<void>
}

/** 声明解析器：驱动要按声明决定 shell / 是否注入 HOME 等行为，但声明由执行面统一算 */
export type FeaturesResolver = (config: WorkspaceConfig) => WorkspaceFeatures
