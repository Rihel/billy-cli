import { z } from 'zod'

/**
 * 工作区运行时配置（`workspace` 命名空间）—— 只放**部署边界**。
 *
 * 终端用户能选的只有"沙箱内的文件权限"（只读 / 可写），**不能选要不要沙箱**：
 * 那是部署方的事（web 产品的安全底线，见 `docs/design/workspace-runtime.md`）。
 */
export const WorkspaceConfigSchema = z.object({
  /**
   * 隔离策略：
   * - `enforce`（默认）：命令只能在沙箱里跑；沙箱不可用就**拒绝执行**（fail closed），
   *   绝不悄悄退回"以服务进程身份跑"；
   * - `off`：不做隔离，命令直接以服务进程身份执行 —— **仅限自托管单租户**，
   *   多租户 / SaaS 部署不要开。
   */
  mode: z.enum(['enforce', 'off']).default('enforce'),
  /**
   * 沙箱内的联网策略。默认 `deny`：同 Pod 的 DB / Redis / k8s API / 云厂商 metadata
   * 都是"一条 curl 就能摸到"的东西，文件隔离挡不住它们。
   *
   * 需要 `npm install` / 调 API 的部署再显式设 `allow`（并接受外传风险）。
   */
  sandboxNetwork: z.enum(['allow', 'deny']).default('deny'),
  /** 沙箱探测超时（ms）：探测失败按"不可用"处理（enforce 下即拒绝执行） */
  probeTimeoutMs: z.coerce.number().int().positive().default(2_000),
})

export type WorkspaceConfigValue = z.infer<typeof WorkspaceConfigSchema>

/** DI 注入 token（WorkspaceConfig 是纯类型，用 Symbol 作运行时标识） */
export const WorkspaceConfig = Symbol.for('WorkspaceConfig')

/** 沙箱探测函数的注入口（测试替换用） */
export const WORKSPACE_PROBE = Symbol.for('WorkspaceProbe')
