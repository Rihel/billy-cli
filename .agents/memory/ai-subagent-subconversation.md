# 子 agent = 子会话：落点与口径

> **查证优先级：必核** —— 字段 / 索引 / 路径类结论；改子会话、工作区共享或删除级联后重核。

## 结论（2026-11-14 第一版）

- 子 agent 建一条 `conversations.kind='subagent'` 的子会话；子 run / timeline 用**子会话 id**，
  `runs.parent_run_id` / `tool_call_id` 保留（幂等与父子树不变）。
- **工作区/文件仍归根会话**：信封带 `workspaceConversationId`，`bash` / `file` 工具按它取路径；
  `conversation.detail` 的文件树也读 `rootConversationId ?? id`。
- 会话列表只出根会话（`parent_conversation_id IS NULL`）；删父会话级联软删子会话，
  文件清理只对根做一次（子会话共享父工作区，不能重复清）。
- 用量 rollup 仍只统计 `parent_run_id IS NULL`；父 run 的 `usage.subAgents` 汇总子 run，不双计。
- `run-sub-agent` 的结论带 `conversationId`；主时间线子助手卡的主入口是「查看过程」= 切主区子 agent tab
  （2026-11-15，`session-tabs.tsx`）；嵌套委派（孙 run 不在本层 tab 列表）退回「打开子会话」跳子会话路由，
  子会话**只读**（隐藏输入框、可返回父会话）。
- 子会话有**自己的 memory thread**（`AgentRunner` 用 childConversationId 建 thread），轮后也走 `MemoryExtractorService`（可选、失败静默）。
- **系统指令**：子 run 起跑时把「主 agent 原稿 + 能力边界尾巴」写一条 `kind=system` 时间线到子会话；
  `runs.request_snapshot.systemPrompt` 只有原稿。`instructions` 对子会话**不查 agent 目录**
  （`sub:<名字>` 会 3303），没快照回 `unrecorded` —— 见 [ai-chat-right-panel](ai-chat-right-panel.md)。
- **仍未做**：子会话单独 resume、分享（分享目前只支持文件）。
- 历史子 run 回填：`pnpm db:backfill-subconversations`（默认预览，`-- --apply` 执行；按 `(parent_run_id, tool_call_id)` 建子会话并迁 runs/timelines）。
- 迁移 `1794700000000-ConversationSubagent`：六个字段 + `uk_conversation_origin`
  （同一父 run 的同一 toolCallId 只建一次子会话）+ 父/创建索引。

## 关键位置

| 位置 | 内容 |
| --- | --- |
| `database/entities/conversation-entity.ts` | 六个新字段 + 两个索引 |
| `runtime/conversation.repository.ts` | `ensureSubagent` / `findChildByOrigin` / `listChildren`；列表过滤 |
| `runtime/agent-runner.ts` | 建子会话 → 子 run；timeline / recorder 用子会话 id；child 信封 |
| `core/envelope.ts` / `core/tools/tool.caller.ts` | `workspaceConversationId` |
| `tools/bash.tool.ts` / `files/file.tools.ts` | 按根会话取工作区 / 文件 |
| `runtime/conversation.service.ts` | detail 文件树用根；remove 级联子会话 |

## 核对命令

```bash
grep -n "parent_conversation_id\|origin_tool_call_id" apps/main/src/database/entities/conversation-entity.ts
grep -n "ensureSubagent\|findChildByOrigin\|listChildren" apps/agent-runtime/src/modules/ai/runtime/conversation.repository.ts
grep -n "childConversationId\|workspaceConversationId" apps/agent-runtime/src/modules/ai/runtime/agent-runner.ts
grep -n "parentConversationId IS NULL" apps/agent-runtime/src/modules/ai/runtime/conversation.repository.ts
grep -n "parent_run_id IS NULL" apps/main/src/modules/ai-usage/ai-usage.rollup.service.ts
```

## 异步边界与用量口径（2026-11-15 实测修正）

- **并发闸门 ≠ 总数**：`SUB_AGENT_MAX_CONCURRENT = 3`（同时跑，超出的**排队**）、
  `DEFAULT_MAX_PER_RUN = 4`（一轮总数，超出的**拒绝**）。第 4 个子助手排队 85 秒是正常现象；
- **创建超时不是失败**：`spawnSubAgent` 等 90 秒，到点先按 `(parent_run_id, tool_call_id)` 回查，
  已建则正常返回；直接 reject 会出现「报超时、实际建好并跑完」（旧 30s 硬编码实测踩过）；
- **父 run 终态后不再建子 agent、不再写其时间线**：异步拒绝回调可能在父 run 收尾后才到，
  写进去就是孤儿事件；中断恢复路径（`interrupted`）例外，仍允许在父收尾后重启；
- **用量补记**：父 run 收尾只汇总「那时已完成」的子 run；异步下子 run 后完成是常态，
  所以子 run 收尾时若父 run 已终态，用 `conversation.addTokens` 把用量补到**根会话**
  （`workspaceConversationId`），同时总会记到子会话自己那份。不补会漏（实测漏 218 万 / 约 40%）。

## 失效信号

子会话支持独立 resume / 分享、子会话自己的 memory thread、历史子 run 回填、工作区改为隔离；
任一出现都要回来改卡片与设计 D10。
