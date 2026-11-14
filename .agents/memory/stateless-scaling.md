# 无状态 Pod 与横向扩展：现状与缺口

> **查证优先级：抽核** —— 结论基于 2026-11-14 的 k8s 清单与 AI 运行时代码；改这些位置后重核。

## 结论

核心 HTTP 业务基本无状态：会话 / 限流 / 锁 / SSE 广播 / AI 运行输出都在 Redis，
业务真相在 PG，附件在对象存储；定时任务（monitor / ai-usage / cleanup）都有 Redis 锁；
同会话并发由 `runs` 的部分唯一索引在 DB 层挡住。Service 不需要 sticky。

**但不是「完全无状态」**，两处仍在 Pod 本地：

1. **AI 会话工作区在 Pod 本地盘**：`{AGENT_COMMAND_WORK_DIR:-~/.billy/workspaces}/<conversationId>`
   （`core/tools/workspace.ts:16`、`:25`），k8s Deployment **没有挂卷**。重启 / 换副本后
   `bash` 与文件工具看到的工作区是空的 —— 这是「本地 agent 体验」在多副本下的缺口。
2. **飞书 CLI 连接器**：配置 / 用户 token 已存 `ai_connectors.auth_state`（2026-11-10），
   调用前 hydrate 到 Pod 本地临时 HOME、调用后 diff 写回，实例级 Redis 锁串行化；
   Pod 本地只剩临时文件，重启 / 换副本不丢授权。

已修复：k8s `10-configmap.yaml:20` 已打开 `AGENT_MULTI_INSTANCE: 'true'`（2026-11-14 核实），
滚动更新不再误伤其它副本在跑的 run；AI 对话 memory thread 已于 2026-11-14 落 Redis
（`ai/mastra/agent-memory.ts`，官方 `@mastra/redis`），重启 / 换副本不丢。

## 可接受的内存态（不影响正确性）

tool config 5s 缓存、connector state 5s 缓存、web 页缓存（ref 失效会明确提示重新抓）、
planner / tool result 内存（有 timeline 兜底）、activeRuns 停止广播（Redis）。
`bash` / lark-cli 产出的文件是 Pod 本地临时物，不是业务真相。

## 核对命令

```bash
grep -n "AGENT_MULTI_INSTANCE" k8s/10-configmap.yaml
grep -n "DEFAULT_WORKSPACE_ROOT\|conversationWorkspace =" apps/agent-runtime/src/modules/ai/core/tools/workspace.ts
grep -n "volumeMounts\|volumes" k8s/20-deployment.yaml || echo "无卷"
grep -n "RedisStore\|createInMemoryAgentMemory" apps/agent-runtime/src/modules/ai/mastra/agent-memory.ts
grep -n "interruptOrphansOnBoot\|multiInstance" apps/agent-runtime/src/modules/ai/runtime/recovery.service.ts
grep -n "replicas" k8s/20-deployment.yaml
```

## 失效信号

工作区改共享存储 / 每会话沙箱；k8s 补工作区卷；memory 换存储；`AGENT_MULTI_INSTANCE` 被改回 false。
