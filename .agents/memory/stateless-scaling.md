# 无状态 Pod 与横向扩展：现状与缺口

> **查证优先级：抽核** —— 结论基于 2026-11-14 的 k8s 清单与 AI 运行时代码；改这些位置后重核。

## 结论

核心 HTTP 业务基本无状态：会话 / 限流 / 锁 / SSE 广播 / AI 运行输出都在 Redis，
业务真相在 PG，附件在对象存储；定时任务（monitor / ai-usage / cleanup）都有 Redis 锁；
同会话并发由 `runs` 的部分唯一索引在 DB 层挡住。Service 不需要 sticky。

**但不是「完全无状态」**：一处 k8s 配置缺失（lark-cli 的授权已在 2026-11-10 入池；AI 对话 thread 已于 2026-11-14 落 Redis）：

1. **AI 对话 memory thread 已落 Redis**（2026-11-14，`ai/mastra/agent-memory.ts`，官方 `@mastra/redis`）：
   重启 / 换副本不再丢；Redis 本身丢了也能从 `timelines` 重建（空 thread 会灌入完整输入）。
   前提是 Redis 开了 AOF 且不是 `allkeys-lru`（compose 目前只有 RDB，见 `docker-compose.yaml`）。
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
grep -n "RedisStore\|createInMemoryAgentMemory" apps/server/src/modules/ai/mastra/agent-memory.ts
grep -n "interruptOrphansOnBoot\|multiInstance" apps/server/src/modules/ai/runtime/recovery.service.ts
grep -n "replicas" k8s/20-deployment.yaml
```

## 失效信号

memory 换成 DB 存储域、lark 授权改为 per-user、k8s 补上 `AGENT_MULTI_INSTANCE`。
（memory 已从进程内换到 Redis，2026-11-14；Redis 自身的持久化配置仍需部署侧确认。）
