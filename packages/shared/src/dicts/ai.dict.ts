import { createDict } from '../utils'

/**
 * AI 会话与运行相关的字典。
 *
 * 术语（全工程统一，勿再造词）：
 * - **轮（turn）**：一次问答（用户发一句 → agent 答完）
 * - **步（step）**：一轮里的一次模型调用（含它引发的工具往返）
 * - **运行（run）**：一次问答在库里的记录（状态、消耗、起止时间）
 */

/** 会话状态 */
export const ConversationStatus = createDict({
  Active: { label: '进行中', value: 'active' },
  Archived: { label: '已归档', value: 'archived' },
})

/** 一次问答（一轮）的运行状态 */
export const RunStatus = createDict({
  Pending: { label: '排队中', value: 'pending' },
  Running: { label: '运行中', value: 'running' },
  /** 挂起：等用户回答工具提出的问题；不是失败，也不能被看门狗判超时 */
  Suspended: { label: '等待回答', value: 'suspended' },
  Succeeded: { label: '已完成', value: 'succeeded' },
  Failed: { label: '失败', value: 'failed' },
  /** 进程崩溃/中断后未能恢复 —— 前端提示"可重试"（重试 = 新建一轮） */
  Interrupted: { label: '已中断', value: 'interrupted' },
  /** 用户主动停止 */
  Canceled: { label: '已取消', value: 'canceled' },
})

/** 失败发生在哪一环（`runs.error_stage`） */
export const RunErrorStage = createDict({
  Model: { label: '模型调用', value: 'model' },
  Tool: { label: '工具执行', value: 'tool' },
  Stream: { label: '流式输出', value: 'stream' },
  Recovery: { label: '崩溃恢复', value: 'recovery' },
  Timeout: { label: '运行超时', value: 'timeout' },
  /** 子 agent 执行环节失败（父那一轮本身可能是好的，是子任务没做完） */
  Subagent: { label: '子 agent', value: 'subagent' },
})

/**
 * 时间线事件的类型。
 *
 * 与 `role` 正交：同一条 `text` 事件，role 可能是 `user` 或 `assistant`。
 */
export const TimelineKind = createDict({
  /** 系统提示词快照（同一会话提示词没变时只写一次） */
  System: { label: '系统提示词', value: 'system' },
  Text: { label: '文本', value: 'text' },
  Reasoning: { label: '推理过程', value: 'reasoning' },
  ToolCall: { label: '工具调用', value: 'tool-call' },
  ToolResult: { label: '工具结果', value: 'tool-result' },
  /** 工具挂起：等用户回答（payload 里有问题定义与 runId） */
  ToolSuspended: { label: '等待回答', value: 'tool-suspended' },
  /** 一次模型调用的边界（带该步的 token 与耗时） */
  Step: { label: '模型调用步', value: 'step' },
  Source: { label: '引用来源', value: 'source' },
  /** 状态变化（含操作人：谁点的停止、谁判的超时、系统恢复重跑） */
  Status: { label: '状态变化', value: 'status' },
  Error: { label: '错误', value: 'error' },
  /** 上下文压缩产物（摘要正文与覆盖范围都在 payload 里） */
  Summary: { label: '上下文摘要', value: 'summary' },
  /**
   * 计划（agent 规划能力的产物）。
   *
   * 落法：每次 `write-plan` 工具返回都追加一条 —— **当前计划 = 最后一条 plan 事件**。
   * 这样计划也是只追加、可复盘的历史（谁在什么时候把哪一步标成了完成，一目了然）。
   */
  Plan: { label: '执行计划', value: 'plan' },
})

/** 时间线事件的角色 */
export const TimelineRole = createDict({
  System: { label: '系统', value: 'system' },
  User: { label: '用户', value: 'user' },
  Assistant: { label: '助手', value: 'assistant' },
})

/**
 * 文件来源：区分「用户上传」与「AI 生成」。
 *
 * 两者都进 `ai_files`，但生命周期不同：用户上传的对象是内容寻址、可能跨会话共享；
 * AI 生成的对象属于本会话。清理 / 配额 / 展示都靠这个字段分流。
 */
export const FileSource = createDict({
  User: { label: '用户上传', value: 'user' },
  Ai: { label: 'AI 生成', value: 'ai' },
})
