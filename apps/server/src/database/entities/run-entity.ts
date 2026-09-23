import { AuditEntity } from '@repo/kits'
import { RunStatus } from '@repo/shared'
import { Column, Entity, Index } from 'typeorm'

/**
 * 运行（一轮问答的完整记录）。
 *
 * 写作时机（务必遵守，见设计文档 §3.12）：
 * - 消息到达：INSERT（pending → running）+ 写 Redis 里的运行中进度；
 * - 推理过程中：**只更新 Redis 进度**，不动本表（避免长过程反复 UPDATE 同一行）；
 * - 跑完：UPDATE 最终结果 + 消耗 + 统计，然后删掉 Redis 进度。
 *
 * 本表**不提供删除**（审计证据），只追加与更新终态。
 */
@Entity('runs')
@Index('idx_run_conversation_created', ['conversationId', 'createdAt'])
@Index('idx_run_status', ['status'])
@Index('uk_run_engine_run_id', ['engineRunId'], { unique: true })
/**
 * 同一会话同时只允许**一次进行中的根运行**：靠数据库挡住并发，不靠"先查再写"的竞态判断。
 *
 * `parent_run_id IS NULL` 是子 agent 的硬前提：**子 run 与父 run 同时 running 是正常状态**，
 * 不加这一条，子 agent 一创建就撞唯一键（见设计文档 §3.14.3）。
 */
@Index('uk_run_active_conversation', ['conversationId'], {
  unique: true,
  where: "parent_run_id IS NULL AND status IN ('pending','running')",
})
/** 按父查子（子 agent 的树形展示与配额统计） */
@Index('idx_run_parent', ['parentRunId'])
/** 幂等去重：同一个父工具调用只允许一个子 run（重放时复用，不重复扣费） */
@Index('uk_run_tool_call', ['parentRunId', 'toolCallId'], {
  unique: true,
  where: 'tool_call_id IS NOT NULL',
})
export class RunEntity extends AuditEntity {
  /** 所属会话 */
  @Column({ name: 'conversation_id', type: 'varchar', length: 20 })
  conversationId!: string

  /** 本次用哪个 agent（会话可换 agent，以本轮为准）；子 agent 记 `sub:<name>` */
  @Column({ name: 'agent_key', type: 'varchar', length: 64 })
  agentKey!: string

  /**
   * 父 run（**子 agent 专用**；`NULL` = 根 run = 一轮问答）。
   *
   * 逻辑引用，**不加物理外键**（工程硬规则）：同一张表递归引用自己更不该加外键，
   * 否则删父会级联影响审计证据。
   */
  @Column({ name: 'parent_run_id', type: 'varchar', length: 20, nullable: true })
  parentRunId: string | null = null

  /** 深度：根 0、子 agent 1（当前工具面已保证不超过 1，配置位留给将来） */
  @Column({ name: 'depth', type: 'int', default: 0 })
  depth = 0

  /** 子 run 专用：**父那次工具调用的 id**（幂等键的一半，重放时同一 id 只生效一次） */
  @Column({ name: 'tool_call_id', type: 'varchar', length: 64, nullable: true })
  toolCallId: string | null = null

  /** 状态：见 RunStatus 字典（pending / running / succeeded / failed / interrupted / canceled） */
  @Column({ name: 'status', type: 'varchar', length: 20, default: RunStatus.Pending })
  status: string = RunStatus.Pending

  /** Mastra durable agent 的 runId（observe / recover 用；为空表示还没真正开跑） */
  @Column({ name: 'engine_run_id', type: 'varchar', length: 64, nullable: true })
  engineRunId: string | null = null

  /** 发起人（= 登录用户 id，审计用） */
  @Column({ name: 'triggered_by', type: 'varchar', length: 20, nullable: true })
  triggeredBy: string | null = null

  /** 发起该轮的 HTTP X-Request-Id（把审计记录与日志 / 告警串起来） */
  @Column({ name: 'request_id', type: 'varchar', length: 64, nullable: true })
  requestId: string | null = null

  /** 送给模型的输入快照（模型 / 参数 / agentRevision / 工具与技能清单 / 上下文裁剪与压缩记录） */
  @Column({ name: 'request_snapshot', type: 'jsonb', nullable: true })
  requestSnapshot: Record<string, unknown> | null = null

  /** 续流用：当前活动流的 id（跑完清空） */
  @Column({ name: 'active_stream_id', type: 'varchar', length: 64, nullable: true })
  activeStreamId: string | null = null

  /** Mastra 的运行快照（存储适配层读写，**我们不解析**） */
  @Column({ name: 'snapshot', type: 'jsonb', nullable: true })
  snapshot: Record<string, unknown> | null = null

  /** 失败错误码（见 AppErrorCodes 的 33xx 段） */
  @Column({ name: 'error_code', type: 'varchar', length: 32, nullable: true })
  errorCode: string | null = null

  /** 失败环节：见 RunErrorStage 字典（model / tool / stream / recovery / timeout） */
  @Column({ name: 'error_stage', type: 'varchar', length: 20, nullable: true })
  errorStage: string | null = null

  /** 失败原因（中文，给用户看） */
  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null = null

  /** 上游错误原文（**全量保留**，仅做密钥掩码，不截断） */
  @Column({ name: 'error_detail', type: 'jsonb', nullable: true })
  errorDetail: Record<string, unknown> | null = null

  /** 崩溃恢复的重跑次数（上限 1，防止无限重跑烧钱） */
  @Column({ name: 'recovery_count', type: 'int', default: 0 })
  recoveryCount = 0

  /** 本轮消耗汇总（步级明细在 timelines 的 step 行，这里不重复存） */
  @Column({ name: 'usage', type: 'jsonb', nullable: true })
  usage: Record<string, unknown> | null = null

  /** 步数：本轮内的模型调用次数 */
  @Column({ name: 'step_count', type: 'int', default: 0 })
  stepCount = 0

  /** 工具调用次数 */
  @Column({ name: 'tool_call_count', type: 'int', default: 0 })
  toolCallCount = 0

  /** 总耗时（ms） */
  @Column({ name: 'duration_ms', type: 'int', nullable: true })
  durationMs: number | null = null

  /** 首字延迟（ms，只有流式才有意义） */
  @Column({ name: 'first_token_ms', type: 'int', nullable: true })
  firstTokenMs: number | null = null

  /** 开始时间 */
  @Column({ name: 'started_at', type: 'timestamp', precision: 3, nullable: true })
  startedAt: Date | null = null

  /** 结束时间（终态时写入） */
  @Column({ name: 'finished_at', type: 'timestamp', precision: 3, nullable: true })
  finishedAt: Date | null = null

  /** 最近一次心跳（**恢复与超时判定的第一依据**） */
  @Column({ name: 'heartbeat_at', type: 'timestamp', precision: 3, nullable: true })
  heartbeatAt: Date | null = null
}
