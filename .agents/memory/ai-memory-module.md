# AI 记忆模块：短期 Redis + 长期 ai_memories

> **查证优先级：抽核** —— 记的是路径与配置形状；改 `modules/ai/memory` 或
> `mastra/agent-memory.ts` 后重核：`git log --oneline -5 -- apps/server/src/modules/ai/memory`。

## 结论

| 要做的事 | 去哪 |
| --- | --- |
| 短期 thread 存储 | `mastra/agent-memory.ts`（生产 `@mastra/redis`，测试 `InMemoryStore`） |
| 长期表 | `database/entities/ai-memory-entity.ts`（`ai_memories`，软删感知唯一键） |
| 业务 | `modules/ai/memory/memory.service.ts`（`collect` / `saveFromTool` / `page` / `update` / `remove`） |
| 工具 | `modules/ai/memory/memory.tools.ts`（save / search / forget，`child: deny`） |
| 注入 | `runtime/context.service.ts` 的 `BuildContextInput.memory`（system 消息） |
| 历史预算 | `memoryHistoryOptions(window)`：每次调用按窗口一半给 `messageHistory.maxTokens` |
| 清理 | `memory-thread-cleanup.service.ts`：每天 04:17 清 30 天前的 thread（Redis 锁） |
| 续跑回灌 | `memory.rehydrate.ts`：thread 空时用 timelines 最近 20 条文本回灌 |
| 自动抽取 | `memory.extractor.service.ts`：信号词 / 每 6 轮 / 未调工具时抽，`source='extract'` |
| 后台 | `/ai-memory/*` + admin `/main/ai/memories` |

- 注入块是 **system 消息**（Mastra 文档口径：系统消息不参与历史裁剪）；注入了哪些 id 写进
  `runs.request_snapshot.context.memory`。
- 上限是 **`@repo/shared` 常量**（每人 200 条 / 单条 500 字 / 每轮 20 条 / 800 token），
  **没有新增环境变量**；工具开关走 `ai_tools.config`。
- 短期 thread 只是缓存，真相在 `timelines`；Redis 需 AOF 且不能 `allkeys-lru`。
  官方适配器没有 TTL，且本版本 `deleteThread` **不删 thread key**，清理直接按键布局 del。
- 记忆按用户归属，`agent_key` 只是收窄；工具身份取自 `ctx.caller.userId`，不接受前端传参。

## 核对命令

```bash
grep -n "memorySave\|memorySearch\|memoryForget" apps/server/src/modules/ai/core/tools/tool-keys.ts
psql "$(sed -n 's/^DB_URL=//p' apps/server/.env)" -c "\d ai_memories"
grep -n "RedisStore\|createInMemoryAgentMemory\|memoryHistoryOptions" apps/server/src/modules/ai/mastra/agent-memory.ts
grep -n "04:17\|isThreadExpired" apps/server/src/modules/ai/memory/memory-thread-cleanup.service.ts
```

## 失效信号

表结构改、工具 key 改、注入通道改成 Mastra working memory / 向量召回、Redis 适配器换掉。
