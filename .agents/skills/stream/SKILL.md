---
name: stream
description: 在 Billy 工程中使用服务端推送（SSE，命名统一为 stream 系）：基于 kits 的 StreamHub 门面（publish 推流 / 频道订阅 / Redis pub/sub 跨实例广播）与 @repo/http-client 的 HttpStreamClient 客户端，覆盖频道命名与身份频道、业务频道白名单、心跳与断线。触发词：SSE、服务端推送、实时推送、推流、事件推送、流式输出、AI 流式、任务进度、实时通知、StreamHub、HttpStreamClient、publish 频道、订阅频道。
---

# 服务端推送（SSE / stream 系）

前置：先加载必读 skill `billy-dev-foundation`（「不重复造轮子」实现查找顺序——**实时推送
用工程自带能力，不引 EventSource / fetch-event-source 等第三方**）。

## 核心要点

- 能力组成：服务端 `StreamHub`（`kits/src/stream/`，Redis pub/sub 跨实例广播，由 `StreamHubModule` 装配）+
  订阅路由 `StreamController`（`apps/server/src/modules/stream/stream.controller.ts`，
  `POST /sse/subscribe`）+ 客户端 `HttpStreamClient`（`@repo/http-client`，浏览器 / Node 双环境）+
  协议契约 `StreamEventSchema` / `StreamSubscribeSchema`（`@repo/shared`）。
- **推流**：任意业务模块构造器 `@Inject(StreamHub)` 注入 → `publish(channel, event)`，
  本实例直推 + Redis 广播（其他实例收到后推各自的本地连接）。
- **频道约定**：`<域>:<id>`（如 `user:42` / `task:42`）；身份频道 `user:{userId}` /
  `admin:{adminId}` 由路由**强制注册**，客户端请求里的 `user:*` / `admin:*` 前缀一律忽略
  （防窃听他人频道）；**业务频道默认拒绝**，需在 `modules/stream/stream.module.ts` 通过
  `SSE_ROUTE_OPTIONS` 注入 `allowChannel` 白名单校验。
- 长连接由 `connection.closed` Promise 挂起，abort 信号自动注销（幂等）；默认 15s 心跳
  注释行保活。

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/stream-guide.md](./references/stream-guide.md) | 服务端 publish / 订阅路由 / 频道权限 / 跨实例广播 / 客户端 HttpStreamClient / 心跳与测试 | 用 SSE / 实时推送 / 事件推送时（必读） |

## 完成检查清单

- [ ] 复用 `StreamHub` 门面（构造器 `@Inject(StreamHub)`），未自写 SSE 传输 / 未引第三方 SSE 库
- [ ] 业务频道已按 `SSE_ROUTE_OPTIONS.allowChannel` 白名单校验（默认仅身份频道，不裸放 `user:*` / `admin:*`）
- [ ] 事件负载用 `StreamEventSchema` 契约（`event` + `data`），频道名符合 `<域>:<id>` 约定
- [ ] 客户端用 `HttpStreamClient`（on 按事件名分发 / connect / close，页面卸载记得 close）
- [ ] 多实例部署时广播依赖 Redis（`root.module.ts` import 了 `RedisModule` + `StreamHubModule` 即装配 `StreamHub`）
