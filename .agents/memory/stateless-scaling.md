# 无状态 Pod 与横向扩展：现状与缺口

> **查证优先级：抽核** —— 结论基于 2026-11-10 的 k8s 清单与 AI 运行时代码；改这些位置后重核。

## 结论

核心 HTTP 业务基本无状态：会话 / 限流 / 锁 / SSE 广播 / AI 运行输出都在 Redis，
业务真相在 PG，附件在对象存储；定时任务（monitor / ai-usage / cleanup）都有 Redis 锁；
同会话并发由 `runs` 的部分唯一索引在 DB 层挡住。Service 不需要 sticky。

**但不是「完全无状态」**：一处功能级本地状态 + 一处 k8s 配置缺失（lark-cli 的授权已在 2026-11-10 入池）：

1. **AI 对话 memory thread 在进程内**：`InMemoryStore`（`ai/mastra/agent-memory.ts:16`）。
   普通新一轮对话不受影响（`chatStream` 每轮从 timelines 重建 messages），但挂起后续跑
   `resumeChat` 依赖 thread 里的历史（`chat.service.ts:1719` 只传一条「用户已回答」；
   设计文档 §3.7.1 自述「无 thread 时 resume 只恢复工具、不发起下一次模型调用」，
   「重启续跑仍需换成落库的 memory」）。换副本 / 重启后续跑的上下文完整性与能否继续，
   需按 Mastra 版本实测（snapshot 里有 messageList，但 thread 仍是进程内）。
2. **飞书 CLI 连接器**：配置 / 用户 token 已存 `ai_connectors.auth_state`
   （2026-11-10），调用前 hydrate 到 Pod 本地临时 HOME、调用后 diff 写回，实例级 Redis 锁串行化；
   Pod 本地只剩临时文件，重启 / 换副本不丢授权。
3. **k8s 少配多实例开关**：`20-deployment.yaml` replicas=3，但 `10-configmap.yaml` 没设
   `AGENT_MULTI_INSTANCE=true`。`AgentRecoveryService.interruptOrphansOnBoot` 在 false 时
   把 `updated_at < 本 Pod 启动时间` 的 pending/running run 标 interrupted
   （`recovery.service.ts:140-147`、`run.repository.ts:435`）——滚动更新时新 Pod 会误伤
   其它副本正在跑的 AI 轮次。

## 可接受的内存态（不影响正确性）

tool config 5s 缓存、connector state 5s 缓存、web 页缓存（ref 失效会明确提示重新抓）、
planner / tool result 内存（有 timeline 兜底）、activeRuns 停止广播（Redis）。
`bash` / lark-cli 产出的文件是 Pod 本地临时物，不是业务真相。

## 核对命令

```bash
grep -n "AGENT_MULTI_INSTANCE" k8s/10-configmap.yaml apps/server/.env.example
grep -n "InMemoryStore" apps/server/src/modules/ai/mastra/agent-memory.ts
grep -n "interruptOrphansOnBoot\|multiInstance" apps/server/src/modules/ai/runtime/recovery.service.ts
grep -n "replicas" k8s/20-deployment.yaml
```

## 失效信号

memory 换成 DB 存储域、lark 授权改为 per-user、k8s 补上 `AGENT_MULTI_INSTANCE`。
