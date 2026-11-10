# Pub/Sub 传输与事件总线（kits）

**查证优先级：抽核** —— 语义随实现改；动广播 / 订阅前先读 `pubsub.ts` / `event-bus.ts` 的类注释。

## 结论（2026-11-10）

- 分三层：`PubSub`（传输）→ `StreamHub`（SSE，`stream:*` 模式订阅）+ `EventBus`（领域事件，`events:<topic>` 精确订阅）。
- `PubSub`：两条 ioredis 连接（订阅模式不能 publish）、**懒建连**、断线重连后自动重订阅、
  自回环按 `instanceId` 过滤、**只收远端**（本地送达由上层做）。
- 语义 **at-most-once**：Redis pub/sub 不持久化，掉线期间消息会丢；可靠投递用 Kafka。
- `EventBus`：发布先本地同步送达再 `events:<topic>` 广播；第一个订阅者建立远端订阅，最后一个移除时释放；
  处理函数抛错只记日志。
- 广播**不能替代库 + 锁**：先写库（带版本）再发失效通知，漏事件靠用时比对版本兜底；
  并发刷新（如轮换 token）仍要分布式锁。
- 模块：`PubSubModule` / `StreamHubModule` / `EventBusModule` 均无自有配置，`root.module` 三者都装配。

## 依据 / 核对命令

```bash
grep -n "class PubSub\|class EventBus\|class StreamHub" packages/kits/src/**/*.ts
grep -n "PubSubModule\|EventBusModule\|StreamHubModule" apps/server/src/root.module.ts
pnpm --filter @repo/kits test test/pubsub.test.ts test/event-bus.test.ts test/stream-hub.test.ts
```

## 失效信号

- 换成 Kafka / 加持久化 / 改成 at-least-once；
- 频道前缀或 topic 规则变化；
- 上层开始自己 new ioredis 做订阅（说明 PubSub 没被复用）。
