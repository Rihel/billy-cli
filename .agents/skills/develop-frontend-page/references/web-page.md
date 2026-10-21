# Web 前台页面模式（develop-frontend-page 引用文件）

> 本文件是 `develop-frontend-page` skill 的组成部分，由主 SKILL.md 引用。
> 写 Web 前台页面时必读。参考 `apps/web/src/app/auth/login/page.tsx` 与
> `apps/web/src/actions/auth.actions.ts`。

## 1. Server Actions（web 侧）

```ts
'use server'

import { defineAction } from '@repo/ui/action'

export const xxxAction = defineAction(
  async (input: I) => {
    const client = createServerClient()
    return client.xxx.do(input)
  },
  { fallbackError: '操作失败，请稍后重试', getError },
)
```

- **两个前端共用同一套约定**：`defineAction`（`@repo/ui/action`）返回
  `{ ok: true, data } | { ok: false, error }`，调用方判 `if (!result.ok)` ——
  不要再各写一份 `wrapAction`（web 曾自带一套 `{ success }`，与 admin 的 `{ ok }` 分叉）。
- 错误文案：`getError` 里 `ApiError` 取 `error.message`（后端中文提示），其余兜底。
- 涉及会话的操作经 `cookies()` 读写 `TokenKey`（`access-token`，httpOnly cookie，7 天）：
  cookie 的安全默认（httpOnly / sameSite / path / secure）取 `@repo/shared` 的
  `authCookieOptions({ maxAge, secure })`，只把「有效期 / 是否生产」传进去。
- 登出用 `try / catch / finally`：撤销会话失败**不能阻断**登出，cookie 必须在 `finally` 里清掉。

## 2. 页面与表单

- 页面组件用 `@repo/ui`：`Button` / `Input` / `FieldGroup` / `Field` / `FieldLabel` /
  `FieldError` / `Spinner` / `Separator`（参考 login 页）。
- 表单提交用 `useActionState`：
  `const [state, formAction, isPending] = useActionState(handler, init)`，
  失败返回 `{ error }` 展示，成功 `router.replace(目标页)`（`useEffect` 监听 redirect）。
- 客户端数据用 TanStack Query（`QueryProvider` 已全局注入）；查询键规范
  `['domain', 'method', { params }]`。完整用例见 `apps/web/src/app/account/page.tsx`
  （`useQuery` 取 `auth.getMe()` + `useMutation` 改资料 / 改密码 + `queryClient.setQueryData` 就地更新）。

## 3. 受保护页面（需要登录态）

前台守卫分两层，**两层都必要、职责不重叠**（参考 `/account`）：

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 边缘中间件 | `apps/web/src/proxy.ts` | 只查 `access-token` cookie 是否存在 → 无 cookie 直接 **307** 到登录页并带 `?next=`；`matcher` 只挂受保护前缀（`['/account/:path*']`），其它页面零开销 |
| 页面 layout | `apps/web/src/app/<区>/layout.tsx` | SSR 调 `getWebAuthState()`（读 cookie → `/auth/get-me`），处理「cookie 在但会话已失效」→ 跳登录页；`AUTH_ENABLED=false` → 回首页 |

- **为什么不能只放 layout**：根 layout 是 `force-dynamic` 且带 `<html>` 外壳，嵌套 layout 抛
  `redirect()` 时响应已在流式输出 —— 只能得到 `HTTP 200` + RSC 里的跳转意图（禁用 JS 就不跳）。
  要真正的 307 必须走中间件。
- **为什么不在中间件调后端**：每个受保护页请求都多一次网络往返；会话有效性判定交给 layout。
- 登录 / 注册页支持 `?next=` 回跳，**必须经 `resolveNextPath`（`apps/web/src/lib/redirect.ts`）
  过滤**：只接受站内相对路径，否则 `?next=https://evil.com` 就是开放重定向。
- 前台登录态有两条凭证链路，页面要用对：SSR / Server Action 用 httpOnly cookie
  （`apps/web/src/lib/auth-session.ts`），浏览器端 SDK 调用用 localStorage token
  （登录 / 注册成功后 `saveToken`）；登出时两条都要清（`removeToken` + `logoutAction`）。

## 4. 前台全局装配（新增能力时最多改这三处）

| 装配 | 文件 | 说明 |
| --- | --- | --- |
| Query + 错误提示 | `apps/web/src/providers/QueryProvider.tsx` | 机制（`QueryCache` / `MutationCache` 的 `onError` 统一 toast、Provider）在 `@repo/ui` 的 `QueryProviders`；app 文件只传前台的策略（`staleTime`） |
| 对象存储 | `apps/web/src/providers/WebStorageProvider.tsx` | 用 `@repo/ui` 的 `StorageClientProvider`（`client` + `resolveUrl`）把 `ImageUpload` / `FileUpload` / `useStorage` 接到 `client.storage.getPresignedUrl` 上；**不装配则上传组件抛错**（`@repo/ui` 不依赖 sdk，必须由应用注入） |
| Toast 容器 | `apps/web/src/app/layout.tsx` 的 `<Toaster />` | 没有它 `toastSuccess` / Query 错误提示全都无声 |

- 应用级兜底文件：`app/error.tsx`（客户端，`reset` 重试）、`app/not-found.tsx`、`app/loading.tsx` ——
  **文件必须在位，但只留一行壳**，版式取 `@repo/ui` 的 `RouteError` / `RouteNotFound`（文案、回跳目标、
  是否展示 `digest` 由 app 决定；`RouteNotFound` 的动作区由 app 传元素，组件库不 import `next/link`）。

## 5. 受保护区内的多页导航

用户在受保护区里有多页时（例：`/account` 账号资料、`/account/sessions` 登录设备），
放一个**客户端区段导航**（`apps/web/src/app/account/nav.tsx`：`usePathname()` 高亮当前页）
在区 layout 的 header 之下；守卫仍由 `proxy.ts` 的 matcher 前缀 + 区 layout 统一负责，子页不重复判断。

列表 + 行内操作（如「下线该设备」）的样板见 `apps/web/src/app/account/sessions/page.tsx`：
`useQuery` 拉列表 → `ConfirmAction`（`@repo/ui`，危险操作二次确认）→ `useMutation` +
`invalidateQueries` 刷新；本机条目不给危险按钮（要退出请用登出）。

## 6. SSR 读公开内容（不需要登录的数据）

公开内容（谁都能看的数据）在 **async Server Component 里直接调 SDK**，不经过浏览器请求、
也不放 Server Action：

- **SDK 的公开方法必须带 `{ skipAuth: true }`**。`post` 默认先解析凭证，服务端客户端没有
  token 时会直接抛「鉴权失败」，**一个请求都发不出去**；页面表现为永远停在加载态。
- 用 React `cache` 把读取包一层：`generateMetadata` 与页面在同一次请求里只打一次后端。
- **读失败不抛 500**：返回 `{ items, error }`，页面上给「暂时打不开 + 重试」；
  后端明确 404（未发布 / 已下架 / 不存在）才 `notFound()`，判据是 `ApiError.status === 404`。
- **给 SSR 请求加 2–3 秒超时**（同 `apps/web/src/lib/auth-session.ts` 的 `withTimeout`）：
  后端挂了不能把整页 SSR 拖住。
- 数据每个请求现取：不依赖构建期静态数据；没有读 cookie 的详情页要显式
  `export const dynamic = 'force-dynamic'`。
