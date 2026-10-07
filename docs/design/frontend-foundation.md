# 前端基础建设：质量检查 + 能力接线 + 业务闭环

> 目标：把前端从「底座基本齐、但无验证手段且已有能力没接上线」补到与后端对等的基建完备度。
> 范围四项：**A 质量检查**（typecheck / test / check:ui）、**B SSE 前端链路**（数据结构 → sdk → hook → 页面）、
> **C web 前台业务闭环**（受保护用户区 + 应用级兜底 + 启用 TanStack Query）、**D 本文档**。

## 1. 现状与缺口（审计结论，均为 2026-09-17 实测）

前端**不是**从头建设 —— 请求层、数据结构层、组件库、应用骨架都已具备：

| 层 | 现状 | 证据 |
| --- | --- | --- |
| 传输 | `@repo/http-client`：4 认证策略 + 4 凭证管理器 + SSE 客户端 | 98 个单测 |
| 数据结构 | `@repo/shared`：zod schema / 字典 / 错误码，前后端同一份 | `schema/*.schema.ts` |
| 客户端 | `@repo/sdk` 的 `ServerClient` 覆盖 auth / admin / user / todo / storage / monitor / config | `server.client.ts` |
| 组件库 | `@repo/ui`：60 个 shadcn 原语 + 24 个自有管理组件 + 4 个 hook | `components/*` |
| 应用骨架 | admin：布局 / 菜单 / 命令面板 / 主题 / Query / 上传 / `proxy.ts` 守卫 / SSR 鉴权 / `defineAction`，10 页可跑；web：落地页 + 4 auth 页 + markdown 示例，SSR 会话探测 | `apps/*/src` |

缺口集中在四处（按影响面排序）：

| # | 缺口 | 实证 |
| --- | --- | --- |
| 1 | **SSE 前端链路断裂** | 后端 `StreamHub`（含排空协议）与客户端 `HttpStreamClient` 均完备，但 `@repo/sdk` 无 stream 入口、两个 app 对 `StreamClient` **零引用**、后端 `streamHub.publish` **零调用** → 对外宣称的实时推送无法验证 |
| 2 | **前端零质量检查** | `apps/web` / `apps/admin` / `packages/ui` 均无 `typecheck` / `test` 脚本，turbo 只声明 `dev` / `build`，`@repo/ui` 连 `scripts` 都没有；真实前端测试文件 **0**（唯一的 `*.test.*` 是陈旧产物 `tsconfig.test.tsbuildinfo`）；类型检查只能人工 `npx tsc --noEmit` |
| 3 | **web 前台业务链路断** | 11 个 page 中 4 个 auth + 5 个 markdown 示例 + 落地页 + comparison；登录后**无受保护业务页**；`QueryProvider` 已挂载但全站零 `useQuery` / `useMutation`；缺 `error.tsx` / `not-found.tsx` / `loading.tsx`（admin 三者齐备） |
| 4 | **前端规范沉淀薄** | `docs/design/` 此前 11 篇无前端基建方案；`develop-frontend-page` 含 references 共 238 行，未覆盖 SSE 接线 / 前端测试 / 应用级兜底 |

**主要矛盾**：后端的「基建完善」由三件事构成 —— **能力 + 生产级默认 + 守卫/测试**；前端第一件基本齐、
第二件一半、第三件接近零。故本轮不做「堆业务页面」，而是补齐**验证手段**与**能力接线**。

## 2. 分层与位置

前端依赖方向（自底向上，禁止反向）：

```
@repo/shared（数据结构：schema / 字典 / 错误码）
   ↓
@repo/http-client（传输：认证注入、凭证管理、SSE 客户端）
   ↓
@repo/sdk（应用数据结构：ServerClient 类型化方法 + createStream）
   ↓
@repo/ui（表现层：shadcn 原语 + 自有组件 + 通用 hook）  ← 不得依赖 http-client / sdk
   ↓
apps/web | apps/admin（页面、Server Actions、providers、stores）
```

| 能力性质 | 位置 | 依据 |
| --- | --- | --- |
| SSE 事件数据结构（事件名 / 负载 schema） | `packages/shared/src/schema/stream.schema.ts` | 共享数据结构归 `shared/schema`（placement 第 2 条） |
| SSE 连接创建 | `packages/sdk/src/server.client.ts` 的 `createStream()` | 全类型客户端归 `sdk`（placement 第 9 条） |
| SSE 订阅的 React 生命周期 | `packages/ui/src/hooks/use-stream.ts` | 通用前端能力归 `@repo/ui` 自有目录（`components/*` / `hooks/*`） |
| 告警广播发布 | `apps/server/src/modules/monitor/alert-trigger.ts` | 业务推流在业务模块（stream skill §2） |
| 实时告警页 | `apps/admin/src/app/main/monitor/live/page.tsx` | 前端页面归 app（placement 第 9 条） |
| 前台受保护用户区 | `apps/web/src/app/account/*` | 同上 |

**应用装配的机制 / 策略分界**（2026-09-18 收口，此前两个 app 各抄一份）：机制归共享层，取值与善后策略留在 app。

| 能力性质 | 位置 | 依据 |
| --- | --- | --- |
| 应用 HTTP 客户端装配（浏览器单例 / 服务端无状态客户端 / 凭证读写 / 401 清凭证） | `packages/sdk/src/app-clients.ts` 的 `createAppClients()` | 它包着 `ServerClient`，而 `@repo/ui` 不允许依赖 sdk / http-client |
| 认证 cookie 的安全默认（httpOnly / sameSite / path / secure） | `packages/shared/src/utils/cookie.utils.ts` | 安全定义不能两端各写一份；变化的只有 `maxAge` / `secure` |
| 地址回落与 key → URL 拼接 | `packages/shared/src/utils/url.utils.ts` 的 `createAppUrlConfig()` | 机制共享；**`process.env` 读取必须留在 app**（`NEXT_PUBLIC_*` 需构建期替换，被外置的包内不替换） |
| Server Action 结果约定 | `@repo/ui/action` 的 `defineAction` | 已有实现，web 曾自带一套 `{ success }` 与之分叉 |
| 主题（三态 / 持久化 / `.dark` 切换 / 防闪烁脚本 / 切换组件） | `packages/ui/src/lib/theme.ts` + `components/theme.tsx` 的 `createTheme()` | 机制共享；**存储 key 由 app 传入**（同域 localStorage 共享，写死会互相改主题） |
| tokenKey / 路由表 / 401 之后干什么（跳哪、是否撤销会话） | 各 app 的 `lib/constants.ts` / `lib/server-client.ts` | 应用私有，作为参数注入 |
| `proxy.ts` / `layout.tsx` / `next/font` 字面量 | 各 app（框架机制，搬不走） | Next 的文件约定与 `next/font` 字面量要求（§7.1） |

**关键取舍**：`useStream` **刻意不依赖 `@repo/http-client`** —— 它只要求一个结构化接口
`StreamClientLike`（`currentState` / `on` / `connect` / `close`），`HttpStreamClient` 天然满足。
理由：`@repo/ui` 是表现层库，若依赖传输包会把「UI 组件库」绑死在某个 HTTP 客户端上，
`apps/*` 也无法注入自定义实现（如测试替身 / 未来的 gRPC-Web 流）。

## 3. A · 前端质量检查

对齐后端已有的三道门（`vitest` + `tsc` + 自定义 `check:*` 守卫）：

| 项 | 内容 |
| --- | --- |
| `typecheck` | `apps/web` / `apps/admin`：`tsc --noEmit`；`packages/ui`：`tsc --noEmit -p tsconfig.json`（include 扩到 `test`，测试文件同样受检） |
| `test` | 三者各加 `vitest run`；`@repo/ui` 用 **jsdom + @testing-library/react**（hook / 组件级测试需要 DOM），两个 app 用默认 node 环境（纯逻辑） |
| turbo | 新增 `typecheck` / `test` 两个 task；根 `pnpm typecheck` / `pnpm test` 一键全量 |
| `check:ui` | 新增守卫 `scripts/check-ui.ts`，把两条既有硬约定变成可执行检查（见下） |

`check:ui` 的两条不变量：

1. **自有组件导出完整性**：`packages/ui/src/components/*.tsx`（不含 shadcn 管理的 `ui/` 子目录）
   每个文件都必须在 `packages/ui/src/index.ts` 的「自有组件」区段导出 —— 防「写了组件没导出，
   下一个人又造一个」。`components/ui/*` 不检查（重型组件刻意按子路径按需引入）。
2. **前端包质量脚本齐备**：凡是依赖 `next` 的 `apps/*`（含 `pnpm cli -t client` 生成的新前端）
   与 `packages/ui`，都必须声明 `typecheck` 脚本 —— 防新前端包漏网，让 `pnpm typecheck` 变成假绿。

不变量 2 属于「公开约定的下游副本」，故同步更新 `scripts/cli/templates/client.ts` 的脚手架模板
（code-conventions 第 12 条）。

## 4. B · SSE 前端链路

### 4.1 服务端：让「已有能力」真的推得出东西

审计发现 `streamHub.publish` 全仓**零调用** —— SSE 只有骨架、没有内容。本轮把**告警**
接上（真实业务事件，不是假数据）：

- `AlertTrigger.deliver()` 是测试告警与规则告警的**唯一发送出口**，在「发送 + 落库」之后
  `publish('admin:all', { event: 'alert.fired', data })`，数据用共享数据结构 `AlertFiredEventSchema`
  显式构造（**不直接推实体**：实体时间戳的生成时机依赖 ORM，数据结构要稳定）。
- 事件名与负载 schema 落 `@repo/shared`（`STREAM_ALERT_FIRED_EVENT` / `AlertFiredEventSchema`），
  与 `STREAM_SHUTDOWN_EVENT` 同处 `stream.schema.ts`。

### 4.2 服务端：修掉「身份二选一」与「广播频道收不到」

原实现有两个硬伤，导致管理员端**任何**推送都收不到：

1. `SSE_ROUTE_OPTIONS.auth` 只能 `'user'` 或 `'admin'`，选了 admin 前台用户就不可用（反之亦然）
   —— SSE 是**双端**能力，改为支持 `'both'`（默认仍 `'user'`，不改变既有语义）。
2. `resolveChannels` 会**忽略**客户端请求的 `admin:*` / `user:*`（防窃听他人身份频道），
   而控制器只强制注册身份频道 `admin:{id}` → 广播频道 `admin:all` **永远没有订阅者**。
   故新增选项 `broadcastChannels`：控制器自动订阅，**但强制校验与当前身份同域**
   （管理员只能拿 `admin:` 前缀、用户只能拿 `user:` 前缀），跨域请求直接忽略。

安全边界不变：业务频道仍由 `allowChannel` 白名单把关（默认全拒），身份频道仍由服务端强制注入。

### 4.3 客户端：sdk 创建 + ui 订阅

```ts
// apps/admin/src/app/main/monitor/live/page.tsx（节选）
const sdk = useServerClient()
const stream = useMemo(() => sdk.createStream(), [sdk])   // 稳定引用：用 useMemo
const { state, connected } = useStream(stream, {
  [STREAM_ALERT_FIRED_EVENT]: (data) => { /* AlertFiredEventSchema.safeParse(data) */ },
})
```

- `ServerClient.createStream(options)`：复用同一个 `baseUrl` / `credentialsManager` /
  `BearerTokenStrategy`，URL 由 `baseUrl` + `/sse/subscribe` 拼出 —— 认证行为与普通请求一致，
  调用方无需重复配置凭证（这正是「能力归 sdk」的价值）。
- `useStream(client, handlers)`：负责 React 生命周期 —— `client` 引用变化时重连、卸载即 `close()`、
  订阅 `open` / `reconnecting` / `closed` 同步连接状态、**handler 存 ref**（函数身份每次渲染
  变化不会触发重连，但始终调用最新实现）。返回 `{ state, connected }`。
  页面隐藏断连 / 恢复重连、心跳、`Last-Event-ID`、排空重连都由 `HttpStreamClient` 负责，hook 不重复实现。

### 4.4 可验证页面

`/main/monitor/live`（运维监控 → 实时告警）：展示连接状态 + 实时事件流（上限 50 条）+
「触发测试告警」按钮（走 `monitor.test`）。点击后经 `AlertTrigger.deliver()` → publish →
SSE → 页面即时出现新事件，形成**端到端自证**（不需要额外准备数据）。

## 5. C · web 前台业务闭环

| 项 | 内容 |
| --- | --- |
| 受保护用户区 | `/account`：`layout.tsx` 做 SSR 会话校验（无会话 `redirect(登录页?next=/account)`，与 admin `main/layout.tsx` 同模式）；`page.tsx` 客户端页，`useQuery` 拉 `auth.getMe()`，支持改资料（头像上传 + 昵称）与修改密码（改完清凭证回登录页） |
| 应用级兜底 | 新增 `error.tsx` / `not-found.tsx` / `loading.tsx`（对齐 admin） |
| 启用数据层 | `QueryProvider` 补 `QueryCache` / `MutationCache` 的 `onError` → toast（对齐 admin），使请求失败有统一提示；`/account` 成为首个真实使用 TanStack Query 的前台页面 |
| 入口可达 | 登录 / 注册支持 `?next=` 回跳；落地页 Header 登录态增加「个人中心」入口（否则 `/account` 不可达） |

## 6. 验证方式

- 门：`pnpm typecheck`、`pnpm test`、`pnpm check:ui`、`pnpm check:inject`、`pnpm check:scaffold`、`pnpm build:pkgs`。
- 守卫有牙齿：`check:ui` 需**反向验证**（故意新增未导出的自有组件 / 摘掉某包 `typecheck` 脚本，
  必须非零退出）。
- SSE 端到端：真实启动 server + 管理员 token 建 SSE 长连接，触发 `monitor.test`，
  断言客户端收到 `alert.fired`；再验广播频道跨域被忽略（前台用户拿不到 `admin:all`）。
- 前端页面：`pnpm dev:web` / `pnpm dev:admin` 实际打开 `/account`、`/main/monitor/live` 走一遍。

## 7. 本轮不做（守边界）

- **不做 i18n**（工程量与当前需求不匹配，用户已明确暂不做）。
- **不做 RBAC / 组织 / 项目 / 团队**（billy-cli 是通用脚手架，非中后台域模型）。
- **不引组件测试框架全家桶**：只补 vitest + jsdom + testing-library 的最小集合，
  不为 `@repo/ui` 建 Storybook / 视觉回归（无真实需求驱动）。
- **不改 SSE 协议**：`Last-Event-ID` 仍只收不补（断线续传为后续版本），多标签页仍各建连。

## 8. 落地记录与实测（2026-09-17）

### 8.1 实际位置

| 项 | 文件 |
| --- | --- |
| 前端质量检查 | 三包 `typecheck` / `test` 脚本、`turbo.json`（`typecheck` / `test` task）、根 `pnpm typecheck` / `pnpm test` / `pnpm check:ui`、`packages/ui/vitest.config.ts`（jsdom）、`scripts/check-ui.ts` |
| 样板测试 | `packages/ui/test/{utils,action,use-stream,tag}.test.*`（26 项）、`apps/web/test/{constants,redirect}.test.ts`（9 项）、`apps/admin/test/theme.store.test.ts`（4 项） |
| SSE 数据结构 | `packages/shared/src/schema/stream.schema.ts`：`STREAM_ADMIN_BROADCAST_CHANNEL` / `STREAM_ALERT_FIRED_EVENT` / `AlertFiredEventSchema` |
| SSE 服务端 | `modules/stream/{options,stream-auth.guard,stream.controller,stream.module}.ts`（`auth: 'both'`、`broadcastChannels`、同域校验、`flushHeaders`）、`modules/monitor/alert-trigger.ts`（发送后 publish） |
| SSE 客户端 | `packages/sdk/src/server.client.ts`（`createStream`）、`packages/ui/src/hooks/use-stream.ts`（`useStream`）、`packages/http-client`（`StreamClientOptions` 凭证泛型化） |
| SSE 页面 | `apps/admin/src/app/main/monitor/live/page.tsx` + `AppMenu` 菜单 |
| web 闭环 | `apps/web/src/app/account/{layout,page}.tsx`、`app/{error,not-found,loading}.tsx`、`src/proxy.ts`、`providers/{QueryProvider,WebStorageProvider}.tsx`、`lib/redirect.ts`、登录/注册 `?next=`、Header 个人中心入口 |

### 8.2 落地过程中修掉的三个真问题（方案阶段未预见，靠实测暴露）

1. **`currentUserId()` / `currentAdminId()` 会抛错**（身份缺失即编程错误）—— `auth: 'both'` 下
   必然有一个缺失（管理员连接没有 userId），控制器同时调用两者 → 写响应头之后抛错 →
   `ERR_HTTP_HEADERS_SENT` 级联 → 连接被硬断。改为直接读 ALS（`requestContext.get(...)`）。
2. **响应头不 flush，客户端迟迟不进入 open**：Node 要等第一次 `write` 才 flush，而长连接的
   下一次写可能是 15s 后的心跳 —— 客户端 fetch 不 resolve、状态停在 `connecting`（前置网关的
   空闲超时也可能先掐断）。控制器 `writeHead` 后显式 `response.flushHeaders()`。
3. **异常过滤器在响应已开始时会二次崩溃**：`response.json()` 抛 `ERR_HTTP_HEADERS_SENT`，
   日志里只剩二次故障、首因被淹没。过滤器新增 `response.headersSent` 分支：记日志 + 结束响应。

### 8.3 与方案的偏差

- **web 受保护路由守卫改用 `apps/web/src/proxy.ts`**（方案原写「layout SSR 校验」）：
  根 layout 流式输出外壳后再 `redirect()` 只能得到 `HTTP 200 + RSC 跳转意图`（拿不到 307、
  禁用 JS 时不跳）。守卫前移到中间件后 `/account` 返回真正的 307，与 admin 同模式；
  layout 侧继续负责「cookie 在但服务端会话已失效」的判定（中间件不请求后端，避免额外往返）。
- **`packages/http-client` 的 `StreamClientOptions` 做了凭证泛型化**：`CredentialsManager` 的
  `setCredentials` 入参使类型不变，`LocalStorageCredentialsManager<BearerTokenCredentials>` 无法
  赋给默认的 `Record<string, any>`；泛型化后 SDK 传具体管理器无需断言（不传类型参数时行为不变）。

### 8.4 实测结果

| 验证 | 结果 |
| --- | --- |
| `pnpm typecheck` | 3/3 通过（web / admin / ui） |
| `pnpm test` | 6 包全绿：ui 26 · web 9 · admin 4 · http-client 96 · kits 129 · server 50 |
| `pnpm check:ui` | ✅；**反向验证有牙齿**：临时新增未导出的自有组件 + 摘掉 `apps/web` 的 `typecheck` → 退出码 1 并准确指出两处违例 |
| `pnpm check:inject` / `pnpm check:scaffold` | ✅（脚手架探针 14 模板 + crud 整体渲染） |
| 生产构建 | `next build` web ✅（12 路由，含 `/account`）、admin ✅（含 `/main/monitor/live`） |
| SSE 端到端（真实 server + SDK 探针） | 6/6：管理员建连即 `open` → `monitor.test` → 收到 `alert.fired` 且负载通过 `AlertFiredEventSchema` → `close()` 终态 → 前台用户以 `auth: 'both'` 建连 → 前台用户**收不到**管理员广播（显式请求 `admin:all` 也被忽略） |
| 页面路由（真实 dev 服务） | 未登录 `/account` → **307** 至 `/auth/login?next=%2Faccount`；带会话 → 200 且渲染出「账号资料 / 修改密码」；`/nope` → 404 兜底；admin 未登录受保护页 → 307；带管理员 cookie 的 `/main/monitor/live` → 200 |

### 8.5 后续修复：长连接请求日志的 requestId（2026-09-17 晚）

- **现象**：`[HTTP] POST /sse/subscribe` 的 `requestId` / `userId` / `adminId` 全是 `null`，
  与响应头 `X-Request-Id` 对不上 —— 长连接的日志关联断链（普通请求正常，所以容易漏）。
- **根因**：`requestContext.run(store, () => next())` 的 ALS 作用域在 `next()` 返回时即退出；
  普通请求只因 `res.end()` 同步发生在处理链路内才读得到 store，而 SSE 的响应结束来自
  `await connection.closed`（由 socket 的 close 回调 resolve），那时 ALS 里已没有本次请求的 store。
- **修复**：`RequestLoggerMiddleware` 改为**注册时捕获 store 引用**（对象可变共享，守卫随后写入的
  身份也读得到），不再在 `finish` 时现取。
- **测试有牙齿**：新增两条回归用例（在作用域外触发 `finish` / 守卫写入身份后触发 `close`）——
  用旧写法跑必然失败（实测 2 failed），修复后通过。
- **实测**：SSE 响应头 `X-Request-Id: zszjtpzqjkshjn2v` 与服务端日志 `requestId` 同值，
  `adminId` 也已带上。

### 8.6 已知缺口（记在案，本轮不修）

- **前台用户身份频道暂无发布方**：`user:{id}` 会被服务端强制订阅，但目前没有业务往用户频道
  publish（待有用户侧实时需求的模块接入，如任务进度）。

