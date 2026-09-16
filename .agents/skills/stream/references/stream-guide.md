# 服务端推送详解（stream 引用文件）

> 本文件是 `stream` skill 的组成部分，由主 SKILL.md 引用。
> 使用 SSE / 实时推送 / 事件推送时必读。协议与实现细节见 `docs/design/sse.md`（设计文档）。

## 1. 能力组成与归位

| 项 | 位置 |
| --- | --- |
| 协议契约（事件 / 订阅体） | `packages/shared/src/schema/stream.schema.ts`（`StreamEventSchema` / `StreamSubscribeSchema`） |
| 服务端推流门面 | `packages/kits/src/stream/stream-hub.ts`（`StreamHub`）+ `stream-connection.ts`（`StreamConnection`） |
| 订阅路由 | `apps/server/src/modules/stream/stream.controller.ts`（`StreamController`，`POST /sse/subscribe`） |
| 客户端 | `packages/http-client/src/stream/`（`HttpStreamClient`，浏览器 / Node 双环境） |

`StreamHub` 由 `StreamHubModule` 装配（`@Global()`，复用 `RedisModule` 的 `RedisConfig` 与
`IdGenerationModule` 的 `IdGeneration`），业务代码构造器 `@Inject(StreamHub)` 注入即可，
无需额外注册；构造器必须显式 `@Inject`，tsx（esbuild）不产出 `design:paramtypes`。

## 2. 服务端：推流（业务模块任意位置）

```ts
// 业务 service / controller 构造器注入
constructor(@Inject(StreamHub) private readonly streamHub: StreamHub) {}

streamHub.publish('task:42', { event: 'progress', data: { percent: 50 } })
streamHub.publish('task:42', { event: 'done', data: { ok: true }, id: 'evt-001' })
```

- `channel` 命名规范 `<域>:<id>`：`user:42` / `admin:all` / `task:42`。
- 广播路径：**本实例直推 + Redis pub/sub 广播**（其他实例收到后推各自的本地连接）；
  广播消息携带发布实例 `instanceId`，自回环消息直接丢弃（避免双推）。
- Redis 故障时本实例直推不受影响；广播 key 为 `stream:{channel}`（内部命名空间，勿手动改）。

## 3. 服务端：订阅路由与频道权限（安全要点）

`apps/server/src/modules/stream/stream.controller.ts` 的 `StreamController`
（业务频道白名单等选项在 `modules/stream/stream.module.ts` 以 `SSE_ROUTE_OPTIONS` 注入）：

```ts
// apps/server/src/modules/stream/stream.module.ts
// 默认：仅身份频道（推荐先这样，业务频道按需放开）
{
  provide: SSE_ROUTE_OPTIONS,
  useValue: { auth: 'user', allowChannel: () => false },
}

// 需要业务频道：注入白名单校验（如 task:42 归属当前用户）
{
  provide: SSE_ROUTE_OPTIONS,
  useValue: {
    auth: 'user',                                  // 'user'（默认）| 'admin'
    allowChannel: (channel: string) => channel.startsWith('task:'),
  },
}
```

- **身份频道强制注册**：`user:{userId}`（或 `admin:{adminId}`），与请求是否携带无关。
- 客户端请求的 `user:*` / `admin:*` 前缀频道**一律忽略**（防窃听他人频道），统一替换为当前身份频道。
- 业务频道（`task:*` 等）默认拒绝，必须经 `allowChannel` 白名单校验（第一版由业务方在 module 配置里自行核对归属权）。
- 认证由 `StreamAuthGuard` 按 `SSE_ROUTE_OPTIONS.auth` 委派给 `UserAuthGuard` / `AdminAuthGuard`
  （`Authorization: Bearer` 或 `access-token` cookie），`AUTH_ENABLED=false` 时守卫放行。

## 4. 客户端：HttpStreamClient（@repo/http-client）

```ts
import { HttpStreamClient, BearerTokenStrategy, MemoryCredentialsManager } from '@repo/http-client'

const sse = new HttpStreamClient({
  url: '/sse/subscribe',          // 完整 URL（含 path）
  channels: ['task:42'],          // 订阅频道；POST 时序列化为 body { channels }
  credentialsManager: new MemoryCredentialsManager({ token }), // 或 LocalStorage/Cookie/Env
  authStrategy: new BearerTokenStrategy(),
})
sse.on('open', () => console.log('已连接'))
sse.on('progress', (data) => setPercent(data.percent))  // 按事件名分发，data 已 JSON 反序列化
sse.connect()
// 页面卸载 / 业务结束时必须 close（避免泄漏）
sse.close()
```

- 状态机：idle → connecting → open ⇄ reconnecting → closed；指数退避重连
  （1s → 2s → 4s，上限 30s，服务端 `retry:` 帧可覆盖），重连前重新解析凭证。
- 内置状态事件 `open` / `reconnecting` / `closed`；`on` 返回取消订阅函数。
- 浏览器默认页面隐藏时断开（`openWhenHidden: true` 可保持）；**恢复可见后必须自动重连**
  （这是 `openWhenHidden` 的契约，`HttpStreamClient` 已用「每次连接尝试新建 AbortController」
  保证——AbortSignal 一旦 abort 就永久 aborted，复用会让恢复后的重连立即被中断、被 transport
  当成正常结束而直接进入 `closed`，表现为切回标签页后流静默失效；回归用例见
  `packages/http-client/test/stream-client.test.ts` 的「恢复可见后自动重连」）。
  服务端默认 15s 心跳注释行保活。
- 退避计数在每次连接成功后重置，故一次长连接的偶发断线按初始间隔（1s）重连，不会直接吃满 30s。
- **服务端排空（滚动更新 / 重启）**：`StreamHub.beforeApplicationShutdown()`（Nest 在
  `httpServer.close()` **之前**调用）会给每条连接推最后一个事件 `stream.shutdown` 再关闭 ——
  只要有一条 SSE 长连接存活，`server.close()` 回调就永不触发、`app.close()` 挂死，
  在途请求会被 SIGKILL 一起带走。客户端收到 `stream.shutdown` 后**立即重连到其他实例**
  （`serverShutdown` 分支，先于「正常结束 → closed 终态」判断），不依赖业务侧注册监听器。

## 5. 场景与注意

- 典型场景：AI 流式输出（`event: 'token'` 逐段推）、任务进度（`event: 'progress'`）、实时通知（`event: 'notification'`）。
- 连接注册表是**本实例内存态**：多实例部署时，广播只推给持有本地连接的实例。
- **前置网关必须关缓冲**：Kong 的 Route 属性 `response_buffering` 默认 `true`，会把 SSE 响应
  缓冲后统一下发 → 流式失效 / 断续。要在该路由（或 Service）上设 `response_buffering = false`；
  同时确认 Service 的 `read_timeout`（Kong 默认 60s）大于心跳间隔（默认 15s）。
  Nginx 同理需要 `proxy_buffering off`。
- **关掉中间层的「响应压缩 / 超时」**：网关的 gzip（`text/event-stream` 一般不该压）与
  LB 的空闲超时都可能在长连接上切流；后端长连接超时见 README「前置反向代理」一节。
- 第一版边界：不做连接上限 / 频道限流；`Last-Event-ID` 只收不补（断线续传为后续版本）；多标签页各自建连、客户端不去重。
- SSE 用 `@Res()` 自行写原始响应（Nest 的 `@Sse()` 只支持 GET），帧格式
  event → data → id（与 @repo/http-client 的 SSE 解析器约定一致）；该路由返回 undefined、
  不经过响应信封拦截器。

## 6. 测试参考

`packages/kits/test/stream-hub.test.ts`（vitest，mock ioredis 的 pub/sub）：覆盖本地直推 +
广播载荷、跨实例路由、自回环过滤、连接注销幂等、abort 自动关闭、心跳、写失败自关，
以及 `beforeApplicationShutdown` 排空（推 `stream.shutdown` + 关闭全部连接 + 排空中新连接立即关闭）。
新增 stream 相关测试照此文件模式写。
