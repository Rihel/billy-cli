import { z } from 'zod'

/**
 * 工具 worker 的注册快照。
 *
 * 注册表是**缓存**，不是真相：worker 自己也要限并发；gateway 拿到的可能是上一拍的负载。
 * 字段只放路由要用的信息，不放密钥、不放出参。
 */
export const WorkerRegistrationSchema = z.object({
  workerId: z.string().min(1).max(128),
  endpoint: z.string().url(),
  version: z.string().min(1).max(64),
  zone: z.string().min(1).max(64),
  /** 支持的 executor 类型（当前只有 bash；后续 web / connector） */
  executors: z.array(z.string()).default([]),
  /** 支持的具体 tool key */
  tools: z.array(z.string()).default([]),
  /** 实际沙箱模式：enforce / off（与 WorkspaceRuntimeService.status 同源） */
  sandboxMode: z.string().min(1),
  maxConcurrency: z.number().int().positive(),
  /** 上一拍的在跑任务数（近似值） */
  active: z.number().int().nonnegative(),
  /** 优雅停机时置 true；gateway 不再派新任务 */
  draining: z.boolean().default(false),
  startedAt: z.string(),
})

export type WorkerRegistration = z.infer<typeof WorkerRegistrationSchema>

/** 存活 ZSET：score = 最后心跳时间（ms） */
export const WORKERS_ALIVE_KEY = 'ai:common-capabilitys:alive'

/** 单个 worker 的 Hash 键 */
export const workerKey = (workerId: string): string => `ai:common-capability:${workerId}`

/**
 * 注册过期时间：心跳 10s、30s 未续视为失联。
 *
 * 只做 gateway 选路的新鲜度判断；**任务本身的存活靠 job lease**，不是这个 TTL。
 */
export const WORKER_STALE_MS = 30_000
