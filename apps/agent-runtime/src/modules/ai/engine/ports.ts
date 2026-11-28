import type { ChatAttachmentModel } from '@repo/shared'
import type { Toolbox, ToolCallerIdentity, ToolSpec } from '../tools/engine/tools.types.js'
import type {
  MemoryExtractionInput,
  MemoryExtractionResult,
} from '../domain/memory/memory.extractor.service.js'
import type { BuiltContext, BuildContextInput } from '../runtime/context/context.service.js'
import type { RunProgress, StreamRecord } from '../runtime/stream/stream-store.service.js'
import type { StepLikeLite } from '../runtime/stream/stream-recorder.js'

/**
 * 引擎能力接缝（设计 §9）。
 *
 * S1 只收口**会被替换**的那几层：模型 / 工具 / 上下文 / 记忆 / 工作区 / 流 / 审批。
 * 接口刻意贴着现有实现的形状：适配器只做转发，不重写行为 —— 换实现时替换适配器，
 * Loop 与 RunExecutor 不动。
 */

/** 工具面：注册机（ToolRegistry）的引擎视图 */
export interface ToolFace {
  /** 授权选择器展开成具体 key（`'*'` / `{ category }`） */
  expand(selectors: readonly string[]): string[]
  /** 按调用身份过滤（越权工具不出现） */
  authorized(keys: readonly string[], caller: ToolCallerIdentity): Promise<string[]>
  /** 取本次可执行的工具表 */
  toolbox(keys: readonly string[]): Toolbox
  /** 单个工具声明 */
  spec(key: string): ToolSpec
  /** 该 key 是否已注册 */
  has(key: string): boolean
}

/** 上下文组装输入：在 ContextService 的形状上补会话身份与附件 */
export interface ContextAssembleInput extends BuildContextInput {
  /** 归属用户（长期记忆注入） */
  userId: string
  /** 本轮 agent key（记忆按 agent 分桶） */
  agentKey: string
  /** 附件（多模态内容由附件服务按存储 key 读回） */
  attachments?: readonly ChatAttachmentModel[]
  /** 本轮模型的输入模态（附件能不能读，由它决定） */
  inputModalities?: readonly string[]
}

/** 上下文组装结果（与 ContextService 的 BuiltContext 同形） */
export type ContextAssembleResult = BuiltContext

/** 上下文接缝：裁剪 / 压缩预算 / 记忆与附件排版 */
export interface ContextAssembler {
  assemble(input: ContextAssembleInput): Promise<ContextAssembleResult>
}

/** 长期记忆注入块（`MemoryService.collect` 的产物） */
export interface MemoryBlock {
  text: string
  ids: string[]
  tokens: number
}

/** 记忆接缝：轮前召回 + 轮后抽取 */
export interface MemoryPort {
  recall(userId: string, agentKey: string): Promise<MemoryBlock | null>
  extract(input: MemoryExtractionInput): Promise<MemoryExtractionResult | null>
}

/** 流接缝：Redis 进度 / 输出记录 / 跨副本停止 */
export interface StreamPublisher {
  bindClient(runId: string, clientId: string): Promise<void>
  startRun(runId: string, patch: Partial<RunProgress>): Promise<void>
  patchRun(runId: string, patch: Partial<RunProgress>): Promise<void>
  readRun(runId: string): Promise<RunProgress | null>
  clearRun(runId: string): Promise<void>
  appendEvent(runId: string, event: unknown): Promise<number>
  appendEvents(runId: string, events: readonly unknown[]): Promise<number>
  readEvents(runId: string, fromRev: number): Promise<StreamRecord[]>
  readAllEvents(runId: string): Promise<StreamRecord[]>
  publishEvent(runId: string, event: unknown): Promise<void>
  publishEvents(runId: string, events: readonly unknown[]): Promise<number>
  subscribeStop(runId: string, onStop: () => void): Promise<() => void>
  publishStop(runId: string): Promise<void>
  waitForReplayGate(runId: string): Promise<void>
  beginReplay(runId: string): Promise<void>
  endReplay(runId: string): Promise<void>
  clearEvents(runId: string): Promise<void>
}

/** 录制接缝：事件 → 时间线（先落库，再推流） */
export interface RunRecorder {
  readonly firstOutputAtMs: number | null
  consume(chunk: unknown): Promise<void>
  flushPending(): Promise<void>
  finish(
    steps?: StepLikeLite[] | null,
  ): Promise<{ toolCallCount: number; errorText: string | null }>
}

/** 录制器工厂：一次 run 一个（带归属上下文与工具元数据） */
export interface RunRecorderFactory {
  create(context: {
    conversationId: string
    runId: string
    isKnownTool?: (key: string) => boolean
  }): RunRecorder
}

/** 工作区文件接缝（读写经 workspace-service，不碰宿主 fs） */
export interface WorkspaceFiles {
  read(workspaceId: string, path: string): Promise<string>
  write(workspaceId: string, path: string, content: string): Promise<void>
  list(workspaceId: string, path?: string): Promise<string[]>
}

/** 工作区命令执行接缝 */
export interface WorkspaceExec {
  run(
    workspaceId: string,
    input: { command: string; cwd?: string; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>
}

/** 工具挂起（等用户回答）的事实 */
export interface ApprovalRequest {
  runId: string
  conversationId: string
  toolCallId?: string
  questions: readonly unknown[]
}

/** 审批接缝：S1 只接 `ask-user-questions` 的挂起 / 续跑两跳 */
export interface ApprovalPort {
  suspend(input: ApprovalRequest): Promise<void>
  resume(input: { runId: string; cancelled: boolean; answerCount: number }): Promise<void>
}
