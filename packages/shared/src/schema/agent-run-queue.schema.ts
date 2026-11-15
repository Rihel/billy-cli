import { z } from 'zod'

/** 会话输入框上方的待执行队列项（只暴露脱敏摘要） */
export const AgentRunQueueItemSchema = z.object({
  id: z.string(),
  source: z.enum(['user', 'subagent']),
  status: z.string(),
  /** 用户消息文本（subagent 项为 null） */
  message: z.string().nullable(),
  /** 子 agent 名称（user 项为 null） */
  subAgentName: z.string().nullable(),
  /** 子 agent 结果摘要（user 项为 null） */
  resultSummary: z.string().nullable(),
  createdAt: z.union([z.string(), z.date()]).optional(),
})
export type AgentRunQueueItemModel = z.infer<typeof AgentRunQueueItemSchema>

export const AgentRunQueueListSchema = z.object({ conversationId: z.string().min(1) })
export type AgentRunQueueListDto = z.infer<typeof AgentRunQueueListSchema>

export const AgentRunQueueUpdateSchema = z.object({
  conversationId: z.string().min(1),
  queueId: z.string().min(1),
  message: z.string().min(1).max(8000),
})
export type AgentRunQueueUpdateDto = z.infer<typeof AgentRunQueueUpdateSchema>

export const AgentRunQueueRemoveSchema = z.object({
  conversationId: z.string().min(1),
  queueId: z.string().min(1),
})
export type AgentRunQueueRemoveDto = z.infer<typeof AgentRunQueueRemoveSchema>
