# AI 运行时在云端多租户下的容量瓶颈（2026-11-14 实测口径）

> **查证优先级：必核** —— 配置类结论，改 k8s / 运行时配置后必须用下面的命令重核。

## 结论（按对「扛流量」的影响排序）

1. **资源限额仍偏紧 / 没有压测**：main requests 100m/256Mi、limits 1 CPU/512Mi；runtime
   requests 250m/512Mi、limits 1 CPU/1Gi。`k8s/60-hpa.yaml` 已加 CPU HPA（需 metrics-server），
   但 AI 并发下的真实内存水位尚未压测；`ToolResultStore` 单实例仍允许 32MB。
2. **没有准入控制**：`/agent/chat/stream` 在 main 只有 `AnyAuthGuard`（runtime 侧不限）；`RateLimitGuard` 只用在
   auth / share 等接口。同会话并发有 `runs` 唯一索引挡住，但一个用户可开多个会话并发跑；
   没有每用户 / 每租户 / 全局并发与排队上限。
3. **工作区持久化依赖 RWX**：`15-pvc-agent-runtime-workspaces.yaml` 已挂
   `~/.billy/workspaces/<conversationId>`，但 PVC 要求 ReadWriteMany；RWO 集群不能开 runtime HPA 多副本。
4. **Redis 流缓冲有双重上限**：`stream-store.service.ts` 每 run 20,000 条 + 32MB（UTF-8 字节），
   TTL 1h；并发长回复仍按「run 数 × 32MB」增长，需要按实际并发核算 Redis 容量。
5. **DB 连接池可配但默认 10/实例**：`DB_POOL_SIZE`（kits `DbConfig`），没有 PgBouncer；
   按副本数 × 池大小核对 PG `max_connections`。
6. **快照写入已改为 `jsonb_set`**（只 set 当前 workflow key，不再读整份 + 回写整份）；但每次 checkpoint 仍整行更新，且 **`runs`/`timelines` 的保留/归档仍未做**（硬规则禁止删除，需分区/归档方案）：`timelines` 每步写多行；durable 快照存 `runs.snapshot` JSONB
   且每步更新（`agent-mastra-store.ts:19`）；迁移里没有分区 / 归档 / 过期删除。

## 另一面：不是瓶颈的地方

- AI 轮次大部分时间在等模型 / 工具，属 I/O 密集；瓶颈先到内存与连接数，不是 CPU。
- SSE 不需要 sticky：断线补发走 Redis，任意副本可续。
- 工作区不需要进程常驻：`bash` 是「一条命令一个进程」，要持久的是文件，不是 shell 状态。

## 核对命令

```bash
grep -n "resources" -A 7 k8s/20-deployment.yaml
ls k8s | grep -i hpa || echo "无 HPA"
grep -rn "RateLimitGuard" apps/agent-runtime/src/modules/ai || echo "AI 接口无 RateLimitGuard"
grep -n "CHUNKS_MAX\|CHUNKS_TTL" apps/agent-runtime/src/modules/ai/runtime/stream-store.service.ts
grep -n "MAX_BYTES" apps/agent-runtime/src/modules/ai/core/tools/tool-result.store.ts
grep -n "poolSize" packages/kits/src/db/db.ts
grep -n "DEFAULT_WORKSPACE_ROOT" apps/agent-runtime/src/modules/ai/core/tools/workspace.ts
grep -n "volumeMounts\|volumes" k8s/20-deployment.yaml || echo "无卷"
```

## 失效信号

出现任一即重核：k8s 加 HPA / 调整资源；main / runtime 再拆或合并；工作区改对象存储或共享卷；
AI 接口加限流 / 排队；`stream-store` 加字节上限；`Db` 支持池配置；时间线开始分区。
