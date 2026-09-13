# SSE 能力落地方案（服务端推流 + 前端客户端）

> 目标：为工程提供**服务端推送（SSE）**基础设施：AI 流式输出、任务进度、实时通知三类
> 场景统一支撑；SSE 客户端能力并入 `@repo/http-client`（通用 HTTP 客户端，请求 + SSE 流）；
> 多实例部署下事件跨实例广播。
> **传输层自研**（原生 fetch + ReadableStream，跨浏览器 / Node），**数据结构与连接状态机
> 自行设计**，认证复用 `@repo/http-client` 的凭证体系。

## 1. 背景与选型

- 现状：工程无任何 SSE 能力（grep 全仓库无 `text/event-stream` / `EventSource` 实现）。
- 诉求（已确认）：
  1. SSE 客户端能力并入 **`@repo/http-client`**（原 `@repo/api-client` 改名，包定位扩展为
     通用 HTTP 客户端：请求 + SSE 流式推送）；
  2. 后端能力放**基础设施**（`kits/src/stream/`）；
  3. 多实例部署，事件需跨实例广播；
  4. SSE 客户端（http-stream-client 定位） **浏览器与 Node.js 双环境可用**；
  5. 认证复用 http-client 的 **CredentialsManager / AuthStrategy / CredentialProvider** 体系；
  6. HTTP method **可配置，默认 POST**（贴合工程「统一 POST + JSON body」约定）。
- 选型结论（按「不重复造轮子」查找顺序评估）：
  - ~~`@microsoft/fetch-event-source`~~：评估后**弃用**。实测其源码 7 处硬引用
    `window.setTimeout` / `window.clearTimeout` / `window.fetch` / `document.hidden` /
    `document.addEventListener('visibilitychange')` 且**无 `typeof` 防御**，Node.js 环境
    直接 `ReferenceError`，不满足双环境诉求。
  - **传输层：自研**（`fetch` + `ReadableStream` + 流式 SSE 帧解析，约百行）。浏览器与
    Node 18+ 均原生提供 `fetch` / `ReadableStream` / `TextDecoder`，零第三方依赖；
    SSE 帧协议（`id/event/data/retry`）是 WHATWG 标准，解析与状态机完全自控。
  - **服务端传输层**：Nest 的 `@Sse()` 只支持 GET，故用 `@Res()` 自行写原始响应，
    帧格式 `event → data → id` 保持重构前字节一致。
  - **跨实例广播**：复用 `RedisStore.raw`（ioredis）的 pub/sub，不引新依赖。
  - **认证**：复用 `@repo/http-client` 的 `CredentialsManager` / `AuthStrategy` /
    `CredentialProvider` / `CredentialResolver` 及现成 managers / strategies（SSE 与
    请求客户端同一包，凭证体系一处定义）。

**分工边界**：`HttpStreamClient` 只做「传输 + 状态机 + 事件分发 + 认证编排」；认证的凭证存取、
策略注入、刷新去重复用 http-client 本包实现，不重复定义。

## 2. 能力归位

| 项 | 决定 |
| --- | --- |
| 协议层（事件契约 / 频道约定） | `packages/shared/src/schema/stream.schema.ts`（zod），`schema/index.ts` 导出 |
| 服务端推流门面 | `packages/kits/src/stream/stream-hub.ts`（`StreamHub`）+ `stream-connection.ts` + `index.ts`，`stream/index.ts` 聚合后由 `packages/kits/src/index.ts` 导出 |
| 服务端 SSE 路由 | `apps/server/src/modules/stream/stream.controller.ts`（`StreamController`，`@Controller('sse')` + `POST subscribe`），鉴权在 `stream-auth.guard.ts`（按 `SSE_ROUTE_OPTIONS.auth` 委派用户 / 管理员守卫） |
| SSE 客户端能力 | `packages/http-client/src/stream/`（`HttpStreamClient` + `stream-transport` + `stream-parser` + `types` + `errors`），随 `@repo/http-client` 导出（**http-stream-client 定位**：流式客户端是 http-client 的能力子模块，不拆独立包） |
| 依赖 | `@repo/http-client`：**零第三方依赖**（认证用本包凭证体系）；广播用 kits 既有 `RedisStore.raw`，零新增 |
| 注册 | `StreamHubModule` 装配（`@Global()`，复用 `RedisConfig` + `IdGeneration`）；生命周期 `OnApplicationBootstrap` 建 pub/sub，`OnApplicationShutdown` 清理 |
| 错误 | `StreamHubError` 加入 `infrastructure-errors.ts`（`AppErrorCodes.Internal`） |

归位依据：`placement.md` §6「外部资源门面 → `kits/src/<基础设施>/`」；HTTP 边界 → controller。

## 3. 数据结构

### 3.1 协议层（shared 契约，前后端共用）

SSE 帧标准：`id` / `event` / `data` / `retry`。

```ts
// shared/src/schema/stream.schema.ts
const StreamEventSchema = z.object({
  event: z.string(),          // 事件名，如 'task.progress'
  data: z.unknown(),          // 任意 JSON 负载（传输层给 string，客户端反序列化）
  id: z.string().optional(),  // 服务端生成的事件 id（续传用，第一版仅透传）
})
type StreamEventModel = z.infer<typeof StreamEventSchema>
```

**频道命名规范**：`<域>:<id>`，如 `user:42` / `admin:all` / `task:42`。
订阅方式：**POST `/sse/subscribe`**，body `{ channels: ['user:42', 'task:42'] }`
（method 可配置，默认 POST，贴合工程「统一 POST + JSON body」约定）。

### 3.2 服务端（kits/src/stream/）

```ts
class StreamHub {                       // @Injectable，生命周期 OnApplicationBootstrap/OnApplicationShutdown
  connections: Map<ConnectionId, StreamConnection>   // 连接注册表
  channels:    Map<Channel, Set<StreamConnection>>   // 频道索引
  publish(channel: Channel, event: StreamEventModel): void
    // 本地直推 + Redis PubSub 广播（见 §5.3）
  createConnection(ctx): StreamConnection             // SSE 路由调用
}

class StreamConnection {
  id: ConnectionId            // nanoid，可作事件 id 前缀
  channels: Set<Channel>
  write(event: StreamEventModel): void  // 写原始响应（帧编码 event → data → id）
  closed: Promise<void>         // request aborted → 触发注销
  close(): void                 // 服务端主动关流
}
```

### 3.3 客户端（packages/http-client/src/stream/）

```ts
interface HttpStreamClientOptions {
  url: string                              // 完整 URL（含 path，如 '/sse/subscribe'）
  method?: string                          // 默认 'POST'；可配 'GET' 等
  channels?: string[]                      // 订阅频道；POST 时序列化为 body { channels }
  body?: unknown                           // 自定义 body（覆盖 channels 默认序列化）
  headers?: Record<string, string>         // 基础 header（如 Content-Type）
  credentialsManager: CredentialsManager   // 本包凭证体系（Memory / LocalStorage / Cookie / Env）
  authStrategy: AuthStrategy               // 本包认证策略（BearerTokenStrategy 等）
  credentialProvider?: CredentialProvider  // 本包凭证提供器（可刷新场景）
  fetch?: typeof fetch                     // 透传，测试注入用（浏览器/Node 均原生）
  openWhenHidden?: boolean                 // 浏览器：页面隐藏是否继续（默认 false）
}

class HttpStreamClient {
  listeners: Map<EventName, Set<Handler>>  // 按事件名分发
  state: HttpStreamClientState                    // 状态机（见 §4）
  private controller: AbortController      // close() 用（传输层唯一停止途径）
  connect(): void
  close(): void
  on(event: EventName, handler: Handler): () => void  // 返回取消函数
}
```

## 4. 状态机

### 4.1 客户端连接状态机（核心）

```
   start()
 idle ──────► connecting
               │ onopen 成功
               ▼
            open ◄──────────────┐
               │ onerror        │ 重连循环（自研，delay 后重试）
               ▼                │
         reconnecting ──────────┘
   close()（任意非终态）──────► closed（终态）
```

| 当前态 | 触发 | 下一态 | 动作 |
| --- | --- | --- | --- |
| idle | `connect()` | connecting | 解析凭证（resolver.resolve）→ 发起连接 |
| connecting | onopen（200 + `text/event-stream`） | open | 通知 open 订阅者 |
| connecting / open | onerror(err) | reconnecting | 通知 reconnecting；`delay(retryMs)` 后重试（重连前重新 resolve 凭证） |
| reconnecting | onopen | open | 通知 open（重连成功） |
| open | onmessage(ev) | open | `JSON.parse(ev.data)` → 按 `ev.event` 分发 |
| 任意非终态 | `close()` | closed | `controller.abort()` → 终态，清理订阅 |
| open | onclose()（服务端正常关流） | closed | 通知 close 订阅者 |

**设计要点**：
1. **重连循环由状态机层自控**（传输层只负责单次连接）：连接结束或出错 → 判定
   reconnecting → 重连前**重新走凭证解析**（token 可能已刷新）→ 再发起新连接。
2. **`closed` 态由 `close()` 自身置位**：`abort()` 后传输层静默终止，不依赖 onclose；
   `onclose` 仅作为「服务端主动关流」的观察信号。
3. **Last-Event-ID**：传输层记录最近事件 `id`，重连时自动带 `Last-Event-ID` header
   （发送侧自研实现）；第一版服务端**只收不补**（忽略该 header，断线后从当前继续）。
4. 重试间隔：默认 1000ms 指数退避（1s → 2s → 4s，上限 30s）；服务端 `retry:` 帧可覆盖。

### 4.2 服务端连接状态机

```
created（路由进入，hub.createConnection）
  → subscribed（按 channels 注册频道索引，开始推流）
  → closed（request aborted 或服务端 close → 注销频道 + 连接表）
```

HTTP 生命周期驱动，无复杂流转；`request aborted` 监听统一走注销（幂等）。

## 5. 关键设计

### 5.1 事件分发 API（客户端）

`sse.on('task.progress', handler)` 按**事件名**分发（channel 隐含在订阅 body 中）；
`on` 返回取消函数；不提供通配符（够用就好，后续需要再加）。

### 5.2 认证（复用 http-client 凭证体系）

- **客户端**：`HttpStreamClient` 构造注入 `credentialsManager` / `authStrategy` /
  `credentialProvider?`（与请求客户端**同一包**，直接复用类型与实现）。连接与重连前经
  `CredentialResolver.resolve()` 取有效凭证 → `authStrategy.getAuthContext()` 生成
  headers（如 `Authorization: Bearer <token>`）→ 合并进 fetch 请求。
  现成实现直接用：`BearerTokenStrategy`、`MemoryCredentialsManager` /
  `EnvCredentialsManager`（跨环境）/ `LocalStorageCredentialsManager` /
  `CookieCredentialsManager`（仅浏览器）。
- **服务端路由**：复用 `extractToken`（`Authorization: Bearer` 或 `access-token` cookie，
  `common/authentication.ts`）。`StreamController` 由 `stream-auth.guard.ts` 的
  `StreamAuthGuard` 保护，按 `SSE_ROUTE_OPTIONS.auth`（`'user' | 'admin'`）委派给
  `UserAuthGuard` / `AdminAuthGuard`。选 fetch 流而非原生 EventSource 正是因为
  EventSource 无法自定义 header。

### 5.3 跨实例广播（Redis PubSub）

- `StreamHub` 持有 **pub / sub 两个独立 ioredis 连接**（ioredis 进入订阅模式后不可
  publish，必须分连接），经 `RedisStore.raw` 的兄弟连接创建，随生命周期启停。
- **广播路径：本地直推 + Redis 广播**（推荐）：
  `publish(channel, event)` → ① 直推本实例本地连接；② `redis.publish('stream:{channel}', JSON)`。
  其他实例收到消息后推各自的本地连接。
- **自回环过滤**：广播消息携带发布实例 `instanceId`（启动时生成），收到 `instanceId
  === self` 的消息直接丢弃（本实例已直推，避免双推）。
- 权衡：本地直推低延迟、Redis 故障时本实例事件仍可达；事件顺序在同一连接内由
  直推保证，跨实例无顺序强约束（SSE 事件互相独立，可接受）。
  （备选：全部走 Redis 单一路径、顺序一致，但本地多一次往返且 Redis 故障全断——不取。）

### 5.4 频道权限（安全要点）

- 服务端强制注册身份频道：`user` 鉴权 → `user:{userId}`；`admin` → `admin:{adminId}`。
- 客户端请求的 channels 中 `user:*` / `admin:*` 前缀一律**忽略并替换为当前身份频道**，
  防窃听他人频道。
- 业务频道（`task:*` 等）由业务方在路由层自行校验（第一版：`modules/stream/stream.module.ts` 的
  `SSE_ROUTE_OPTIONS` 提供 `allowChannel` 白名单 / 校验回调注入点，默认仅允许身份频道）。

### 5.5 心跳

复用帧注释行 ping（周期写注释行，服务端保活）；传输层无心跳检测（网络断开由
fetch 读流抛错自然进入 reconnecting），客户端状态机据此重连。

## 6. 使用示例

```ts
// ===== 服务端：业务模块发事件（任意实例） =====
// streamHub 由构造器注入：@Inject(StreamHub) private readonly streamHub: StreamHub
streamHub.publish('task:42', { event: 'progress', data: { percent: 50 } })

// ===== 服务端：SSE 路由（modules/stream/stream.controller.ts） =====
// POST /sse/subscribe  body: { channels: ['user:42', 'task:42'] }（Bearer 认证）
// 内部：hub.createConnection(ctx) → @Res() 写原始响应长连接 → 按 channels 注册 → 推流

// ===== 客户端（前端 / Node 通用，来自 @repo/http-client） =====
import { HttpStreamClient, BearerTokenStrategy, MemoryCredentialsManager } from '@repo/http-client'

const sse = new HttpStreamClient({
  url: '/sse/subscribe',
  channels: ['task:42'],
  credentialsManager: new MemoryCredentialsManager({ token }), // 或 LocalStorage/Cookie/Env
  authStrategy: new BearerTokenStrategy(),
})
sse.on('open', () => console.log('已连接'))
sse.on('progress', (data) => setPercent(data.percent))
sse.connect()
// ... 页面卸载 / 业务结束时
sse.close()
```

## 7. 测试

- **HttpStreamClient**（vitest，`pnpm --filter @repo/http-client test`，Node 环境直接跑）：
  传输层解析（分块返回的 SSE 帧、多行 data、注释行、`retry:` 覆盖、`id` 记录）、
  状态机转移（connect → open → reconnecting → open / close 置 closed）、method 默认
  POST 与 body 序列化、认证注入（manager/strategy 生成 header）、重连前重新取凭证、
  data 非 JSON 时原样分发原始字符串（不崩溃）、abort 停止重连。
  用注入 `fetch`（Node 原生）模拟流式响应。
- **StreamHub**（vitest，mock Redis pub/sub）：publish 本地直推、广播消息路由到
  本地连接、自回环 instanceId 过滤、连接注册/注销幂等、频道权限替换。
- 错误继承 `StreamHubError`（`AppErrorCodes.Internal`）。

## 8. 边界 / 注意事项

- 连接数无上限约束：第一版不做连接上限 / 频道限流（按需再加）。
- 进程内连接不跨实例共享：连接注册表是本实例内存态，广播只推持有本地连接的实例。
- `Last-Event-ID` 续传（断线补发）为后续版本：需服务端事件缓冲，第一版只收不补。
- 多标签页：同一浏览器多标签各自建连，客户端层不做去重（业务侧自行决定）。
- `@repo/http-client` **零第三方依赖**；`TextDecoder` / `fetch` / `ReadableStream` 为
  浏览器与 Node 18+ 原生，无需 polyfill。
- 国内镜像源配置保持不变；新增包在 `pnpm-workspace.yaml` 通配范围内，无需改 workspace。

## 9. 评审确认点

以下为**推荐默认值**，评审时确认或调整：
1. 事件分发按事件名（非按频道）——§5.1
2. Last-Event-ID 第一版只收不补——§4.1.3
3. 广播路径：本地直推 + Redis（带 instanceId 过滤）——§5.3
4. 重连退避：指数退避 1s→2s→4s 上限 30s，`retry:` 帧可覆盖——§4.1.4
