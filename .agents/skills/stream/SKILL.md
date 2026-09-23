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
  客户端入口 `ServerClient.createStream()`（`@repo/sdk`）+ React 生命周期 `useStream`
  （`@repo/ui`）+ 协议契约 `StreamEventSchema` / `StreamSubscribeSchema`（`@repo/shared`）。
- **推流**：任意业务模块构造器 `@Inject(StreamHub)` 注入 → `publish(channel, event)`，
  本实例直推 + Redis 广播（其他实例收到后推各自的本地连接）。
- **频道约定**：`<域>:<id>`（如 `user:42` / `task:42`）；身份频道 `user:{userId}` /
  `admin:{adminId}` 由路由**强制注册**，客户端请求里的 `user:*` / `admin:*` 前缀一律忽略
  （防窃听他人频道）；**广播频道**（如 `admin:all`，见 `STREAM_ADMIN_BROADCAST_CHANNEL`）
  只能由服务端通过 `SSE_ROUTE_OPTIONS.broadcastChannels` 注入，且**只放行与当前身份同域**的项；
  **业务频道默认拒绝**，需在 `modules/stream/stream.module.ts` 通过
  `SSE_ROUTE_OPTIONS` 注入 `allowChannel` 白名单校验。
- **双端可用**：`SSE_ROUTE_OPTIONS.auth` 支持 `'user' | 'admin' | 'both'`，当前工程用 `'both'`
  ——前台用户与后台管理员都能订阅；身份由守卫写入的 ALS 决定（**不要**用会抛错的
  `currentUserId()` / `currentAdminId()` 去拼频道，另一身份必然缺失）。
- **前端三件套（推荐路径）**：`client.createStream()` → `useStream(client, { '事件名': handler })`
  ——认证复用同一份凭证、挂载建连、卸载 `close()`、状态同步进 React；页面隐藏断连与
  服务端排空重连都由客户端负责。
- 长连接由 `connection.closed` Promise 挂起，abort 信号自动注销（幂等）；默认 15s 心跳
  注释行保活；响应头 `writeHead` 后必须 `flushHeaders()`（否则客户端 fetch 要等到第一次
  write 才 resolve，状态停在 connecting）。

## 与 AI 会话流的边界（别混用）

AI 会话的流式输出**不走本 skill 的 StreamHub/HttpStreamClient**：它用的是 AI SDK v6 的
UI Message Stream 协议（前端 `useChat` 直接消费），服务端自己写 SSE 帧、自己用
`AgentStreamStore`（Redis）做输出记录与广播，端点是 `POST /agent/chat/stream`（建流）+
`GET /agent/run/:runId/stream?offset=N`（重连，无进行中流回 204）+ `POST /agent/run/stop`（停止）。
要改那一条链路，看 skill `develop-ai-agent` 的 `references/runtime.md`（含 `data-*` 块约定与两处官方语义坑）。

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/stream-guide.md](./references/stream-guide.md) | 服务端 publish / 订阅路由 / 频道权限 / 跨实例广播 / 客户端 HttpStreamClient / 心跳与测试 | 用 SSE / 实时推送 / 事件推送时（必读） |

## 完成检查清单

- [ ] 复用 `StreamHub` 门面（构造器 `@Inject(StreamHub)`），未自写 SSE 传输 / 未引第三方 SSE 库
- [ ] 业务频道已按 `SSE_ROUTE_OPTIONS.allowChannel` 白名单校验（默认仅身份频道，不裸放 `user:*` / `admin:*`）；
      需要全体管理员广播时用 `broadcastChannels`（如 `STREAM_ADMIN_BROADCAST_CHANNEL`），不要在控制器里手写频道名
- [ ] 事件负载用共享契约（`event` + `data`，专用事件在 `packages/shared/src/schema/stream.schema.ts` 定 schema），频道名符合 `<域>:<id>` 约定
- [ ] 前端用 `client.createStream()` + `@repo/ui` 的 `useStream`（不要手写 EventSource / 自己管 useEffect 重连）；
      非 React 场景才直接用 `HttpStreamClient`，且页面卸载必须 `close()`
- [ ] 新增 / 修改了 SSE 路由实现时，控制器保持 `writeHead` 后 `flushHeaders()`，并确认异常过滤器在 `headersSent` 时不会二次崩溃
- [ ] 多实例部署时广播依赖 Redis（`root.module.ts` import 了 `RedisModule` + `StreamHubModule` 即装配 `StreamHub`）
