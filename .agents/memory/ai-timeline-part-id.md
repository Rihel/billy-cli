# 时间线 part id（`payload.id`）

**查证优先级：必核**

`timelines` 里 **assistant 的 text / reasoning 行**带 `payload.id`（= 流里的 part id）。
用途只有一个：断线重连时把「时间线快照」与「增量补发」按 id 去重，否则同一段渲染两遍。

两条写入路径都必须带：

1. **流式**：`stream-recorder` 的 `flushText` / `flushReasoning`（`payload: { text, id }`）；
2. **非流式**（`agent.generate`，`POST /agent/chat` 离线 / CLI / 自调用）：
   `chat.service` 的 `persistSteps`（`id: '<messageId>:text' / ':reasoning'`，派生 id）。

用户消息的 text 行**故意没有** `id`（不是 part）。

## 老数据（升级前）：不做回填

2026-11-17 02:30（`7351aec`）之前落库的 text / reasoning 行没有 `payload.id`；
快照去重对无 id 的 part 只能「保留」（宁可重复不丢）。

实测（2026-11-17 深夜，本地库）：缺 id 的行 2,465 条，**全部属于终态 run**
（succeeded 2349 / interrupted 46 / failed 38 / canceled 8 / 无 run 24，0 条属于 running / suspended）。
重复只可能发生在"正在跑"的轮次（输出记录还活着），所以这批老行的残留**不可能出现**，
不必回填、也不该动审计行。

## 核对命令

```bash
DBURL=$(grep -E '^DB_URL=' apps/agent-runtime/.env | sed 's/^DB_URL=//')
psql "$DBURL" -c "select kind, count(*) filter (where payload->>'id' is null) legacy
  from timelines where kind in ('text','reasoning') group by 1;"          # 只应出现在历史行
psql "$DBURL" -c "select r.status, count(*) from timelines t left join runs r on r.id=t.run_id
  where t.kind in ('text','reasoning') and t.payload->>'id' is null group by 1;"  # 不应有 running / suspended
grep -n "id: \`\${messageId}:text\`" apps/agent-runtime/src/modules/ai/runtime/chat.service.ts
```

## 失效信号

若将来有第三条写 text / reasoning 的路径（新的执行入口），必须同步带 `payload.id`；
`buildMessageParts` 与 `run-snapshot` 的 `seedPartId` 都靠它对齐。回归用例：
`test/ai-chat-e2e.test.ts`「非流式路径的文本 / 推理行也带 part id」、
`test/ai-message-snapshot.test.ts` 的 part id 断言。
