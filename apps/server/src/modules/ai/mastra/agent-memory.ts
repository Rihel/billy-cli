import { InMemoryStore } from '@mastra/core/storage'
import { Memory } from '@mastra/memory'

/**
 * 主 agent 的对话记忆。
 *
 * 为什么现在必须有它：durable agent 的 `resumeStream` 恢复工具之后，
 * 要靠 memory thread 把工具结果续回消息列表，才能发起下一次模型调用；
 * 没有 thread 时流会停在 `tool-call-resumed`（实测 mock 只收到一次请求）。
 *
 * 当前用 `InMemoryStore`：进程内正确，重启会丢消息 —— 这是**已知缺口**，
 * 后续换成落 PostgreSQL 的 memory 存储域（或启动时从 `timelines` 回灌）。
 */
export const createAgentMemory = (): Memory =>
  new Memory({
    storage: new InMemoryStore(),
    options: {
      lastMessages: 20,
      semanticRecall: false,
      workingMemory: { enabled: false },
    },
  })

/**
 * 进程级单例：Agent 构造时挂它，`stream` / `resumeStream` 的 `memory.thread`
 * 才能命中同一个 thread。**不能每次 new** —— 那样每条流都是空记忆。
 */
export const agentMemory = createAgentMemory()
