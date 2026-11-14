import { InMemoryStore } from '@mastra/core/storage'
import { Memory } from '@mastra/memory'
import { RedisStore } from '@mastra/redis'

/**
 * 主 agent 的对话记忆（短期记忆，设计 `docs/design/ai-memory.md` §4）。
 *
 * 为什么必须有它：durable agent 的 `resumeStream` 恢复工具之后，要靠 memory thread
 * 把工具结果续回消息列表，才能发起下一次模型调用；没有 thread 时流会停在
 * `tool-call-resumed`（实测 mock 只收到一次请求）。
 *
 * 存储选择：**生产用 Redis**（`@mastra/redis`，官方适配器）——
 * 进程重启 / 换副本都不丢，Redis 里丢了也能从 `timelines` 重建（空 thread 会把整份输入
 * 当作种子灌进去）。单测 / 脚本用 `InMemoryStore`，不要求本机起 Redis。
 *
 * 口径：thread 是**缓存**，不是真相；对话内容的事实源始终是 `timelines`。
 */

/** 记忆配置：历史由**每次调用的 token 预算**决定（见 `memoryHistoryOptions`） */
const MEMORY_OPTIONS = {
  semanticRecall: false,
  workingMemory: { enabled: false },
} as const

/**
 * 这一轮允许带进上下文的历史预算（按模型窗口的一半）。
 *
 * 为什么按 token 而不是条数：一条工具结果可能几千 token，20 条可能撑爆窗口，
 * 也可能只占十分之一 —— 条数不是容量的代理（Mastra 文档同口径）。
 * `atMaxRemoveTokens` 给 1/4，超预算时按块释放，避免刚压完又触发。
 *
 * 用法：`agent.stream(messages, { memory, memoryOptions: memoryHistoryOptions(window) })`。
 */
export const memoryHistoryOptions = (windowTokens: number) => ({
  messageHistory: {
    maxTokens: Math.max(1024, Math.floor(windowTokens * 0.5)),
    atMaxRemoveTokens: Math.max(256, Math.floor(windowTokens * 0.125)),
  },
})

/** 生产实现：thread 落 Redis（连接由调用方按应用配置给） */
export const createAgentMemory = (redisUrl: string): Memory =>
  new Memory({
    storage: new RedisStore({
      id: 'billy-agent-memory',
      connectionString: redisUrl,
    }),
    options: MEMORY_OPTIONS,
  })

/** 测试 / 无 Redis 场景：进程内实现，重启即丢 */
export const createInMemoryAgentMemory = (): Memory =>
  new Memory({
    storage: new InMemoryStore(),
    options: MEMORY_OPTIONS,
  })

/**
 * 进程级单例（测试与脚本的默认值）：Agent 构造时挂它，`stream` / `resumeStream` 的
 * `memory.thread` 才能命中同一个 thread。**不能每次 new** —— 那样每条流都是空记忆。
 */
export const agentMemory = createInMemoryAgentMemory()

/** DI token：生产装配时由 `ai.module` 注入 Redis 实现 */
export const AGENT_MEMORY = Symbol.for('AgentMemory')
