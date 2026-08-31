# 服务端推送详解（stream 引用文件）

> 本文件是 `stream` skill 的组成部分，由主 SKILL.md 引用。
> 使用 SSE / 实时推送 / 事件推送时必读。协议与实现细节见 `docs/design/sse.md`（设计文档）。

## 1. 能力组成与归位

| 项 | 位置 |
| --- | --- |
| 协议契约（事件 / 订阅体） | `packages/shared/src/schema/stream.schema.ts`（`StreamEventSchema` / `StreamSubscribeSchema`） |
| 服务端推流门面 | `packages/kits/src/infrastructure/stream/stream-hub.ts`（`StreamHub`）+ `stream-connection.ts`（`StreamConnection`） |
| 订阅路由 | `apps/server/src/features/stream.ts`（`makeStreamRoutes`），`main.ts` 挂载 `/sse` |
| 客户端 | `packages/http-client/src/stream/`（`HttpStreamClient`，浏览器 / Node 双环境） |

`StreamHub` 是生命周期组件：`createServiceContext({ redis })` 传入 redis 即自动装配
（`addLifeCycleService`），业务代码直接 `runtime.get(StreamHub)`，无需额外注册。

## 2. 服务端：推流（业务模块任意位置）

```ts
const streamHub = runtime.get(StreamHub)
streamHub.publish('task:42', { event: 'progress', data: { percent: 50 } })
streamHub.publish('task:42', { event: 'done', data: { ok: true }, id: 'evt-001' })
```

- `channel` 命名规范 `<域>:<id>`：`user:42` / `admin:all` / `task:42`。
- 广播路径：**本实例直推 + Redis pub/sub 广播**（其他实例收到后推各自的本地连接）；
  广播消息携带发布实例 `instanceId`，自回环消息直接丢弃（避免双推）。
- Redis 故障时本实例直推不受影响；广播 key 为 `stream:{channel}`（内部命名空间，勿手动改）。

## 3. 服务端：订阅路由与频道权限（安全要点）

`apps/server/src/features/stream.ts` 的 `makeStreamRoutes(runtime, options?)`：

```ts
// 默认：仅身份频道（推荐先这样，业务频道按需放开）
app.route('/sse', makeStreamRoutes(runtime))

// 需要业务频道：注入白名单校验（如 task:42 归属当前用户）
app.route('/sse', makeStreamRoutes(runtime, {
  auth: 'user',                                  // 'user'（默认）| 'admin'
  allowChannel: (channel) => channel.startsWith('task:'),
}))
```

- **身份频道强制注册**：`user:{userId}`（或 `admin:{adminId}`），与请求是否携带无关。
- 客户端请求的 `user:*` / `admin:*` 前缀频道**一律忽略**（防窃听他人频道），统一替换为当前身份频道。
- 业务频道（`task:*` 等）默认拒绝，必须经 `allowChannel` 白名单校验（第一版由业务方在路由层自行核对归属权）。
- 认证复用 `makeRequireAuth` / `makeRequireAdminAuth`（`Authorization: Bearer` 或 `access-token` cookie），`AUTH_ENABLED=false` 时守卫放行。

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
- 浏览器默认页面隐藏时断开（`openWhenHidden: true` 可保持）；服务端默认 15s 心跳注释行保活。

## 5. 场景与注意

- 典型场景：AI 流式输出（`event: 'token'` 逐段推）、任务进度（`event: 'progress'`）、实时通知（`event: 'notification'`）。
- 连接注册表是**本实例内存态**：多实例部署时，广播只推给持有本地连接的实例。
- 第一版边界：不做连接上限 / 频道限流；`Last-Event-ID` 只收不补（断线续传为后续版本）；多标签页各自建连、客户端不去重。
- hono 入口：**`hono/streaming`**（4.12.x 的 exports；4.13+ 的 `hono/helper/streaming` 仅新版本才有，勿混用）。

## 6. 测试参考

`packages/kits/test/stream-hub.test.ts`（vitest，mock ioredis 的 pub/sub）：覆盖本地直推 +
广播载荷、跨实例路由、自回环过滤、连接注销幂等、abort 自动关闭、心跳、写失败自关。
新增 stream 相关测试照此文件模式写。
