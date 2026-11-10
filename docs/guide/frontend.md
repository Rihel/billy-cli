# 前端（Web 与 Admin）

> 两个独立入口共用一套设计系统与组件库：Web 面向 C 端，Admin 面向后台。
> 组件库与设计系统细节见本篇；布局与依赖规则见 [architecture.md](./architecture.md)。

## apps/web — Next.js 16 前台

面向 C 端的前台应用，使用 **Base UI + shadcn/ui**（来自 `@repo/ui`）与 Tailwind 4；
视觉取值（配色 / 圆角 / 字体回退链 / 组件质感规则）统一来自设计系统包 **`@repo/ui`**，
`src/app/globals.css` 只保留设计系统入口、`@source` 与前台专属的 `@keyframes`。

- 页面：`/`（首页）、`/auth/*`（登录 / 注册 / 忘记密码 / 重置密码）、`/account`（**个人中心**：账号资料）与 `/account/sessions`（**登录设备**：列表 + 单设备下线），受保护用户区、`/comparison`（竞品调研）、`/markdown/*`（Markdown 渲染示例）
- 首页（`components/landing/*`）：Hero → 事实横带 → 技术栈滚动 → **AI 能力**（对话 / 工具 / 连接器）→ 可观测性 → 设计系统 → 维护性 → 快速开始 → CTA；页面上的数字（内建工具 / 连接器型号 / Agent Skills / ai-elements）与 README 同一口径，改能力时两处一起改
- Server Actions（`actions/auth.actions.ts`）封装登录 / 注册 / 忘记密码 / 重置密码 / 登出，token 写入 httpOnly cookie
- `lib/server-client.ts`：调用 `@repo/sdk` 的 `createAppClients` 装配 HTTP 客户端（浏览器端单例 + 服务端无状态客户端 + 凭证读写），本文件只注入 `tokenKey` / 两端地址 / 401 善后；`lib/constants.ts` 的地址解析走 `@repo/shared` 的 `createAppUrlConfig`（环境变量读取留在 app，`NEXT_PUBLIC_*` 需构建期替换）；httpOnly cookie 在 `lib/auth-session.ts` 读取
- `providers/QueryProvider.tsx` 注入 TanStack Query（`QueryCache` / `MutationCache` 的 `onError` 统一 toast）；`providers/WebStorageProvider.tsx` 把 `@repo/ui` 的上传组件接到 `storage.getPresignedUrl`；`providers/ThemeProvider.tsx` 应用已存储 / 系统的主题（**前台已支持暗色**，入口在落地页头部与移动端抽屉）
- 受保护页两层守卫：`src/proxy.ts` 中间件（只查 cookie → 无 cookie 真实 307 到 `/auth/login?next=`，`matcher` 只挂 `/account/:path*`）+ `app/account/layout.tsx` 的 SSR 会话校验；`?next=` 回跳经 `lib/redirect.ts` 过滤（防开放重定向）
- 应用级兜底：`app/error.tsx`（可重试）、`app/not-found.tsx`、`app/loading.tsx`
- `app/layout.tsx` 标记 `force-dynamic`：前端根 layout 统一动态渲染（每次请求 SSR，不做静态预渲染）
- `next.config.ts`：`output: 'standalone'`、React Compiler、transpile `@repo/ui`

## apps/admin — Next.js 16 管理后台

面向后台的管理应用，与前台同源使用 **@repo/ui**（shadcn/ui 风格）与 **`@repo/ui`**
（设计系统，完整深色模式），表格用
**@tanstack/react-table**（`DataTable`）、表单用 **@tanstack/react-form**
（`ModalForm` / `DrawerForm` / `FormRenderer` 声明式 items），适合表格 / 表单 / 权限类页面。
登录使用**后台管理员**账号（`AdminEntity`，`/admin/*` 接口），与前台用户体系隔离。

- 页面：`/auth/login`（管理员登录）、`/main/dashboard`、`/main/user-center`（含**登录设备**区块）、
  `/main/system/users`、`/main/system/admins`（管理员管理）；
  运维监控五页：`/main/monitor/status`（状态）、`/main/monitor/live`（**实时告警**，SSE）、
  `/main/monitor/metrics`（指标）、`/main/monitor/logs`（告警记录）、`/main/monitor/rules`（告警规则）；
  AI 五页：`/main/ai/chat`（会话，含运行详情）、`/main/ai/models`（供应商 / 模型）、
  `/main/ai/tools`（工具开关与限额）、`/main/ai/audit`（调用审计 / 用量）、
  `/main/ai/connectors`（连接器：数据库 / Redis / 飞书 CLI 实例）
- 实时告警页把 SSE 链路走通：`client.createStream()`（`@repo/sdk`）→ `useStream`（`@repo/ui`）
  → 告警发送后 `StreamHub.publish('admin:all', 'alert.fired')` 实时到达；页内「触发测试告警」
  可一键自检全链路（协议与频道权限见 `stream` skill 与 `docs/design/frontend-foundation.md`）
- 布局：`AppHeader` + `AppSider` + `AppMenu`；根 `app/layout.tsx` 与 `main/layout.tsx` 均标记
  `force-dynamic`（前者让前端根 layout 统一动态渲染，后者在 SSR 侧通过 cookie 调用
  `admin.getMe()` 做鉴权，失败 `redirect()` 到登录页）
- 路由守卫：`proxy.ts` 中间件按 `PublicPaths` + cookie 判断，未登录访问非公开页时 `redirect()` 到登录页（不对已登录用户做反向重定向）
- Server Actions：`@repo/ui/action` 的 `defineAction` / `callAction` 统一返回
  `{ ok, data } | { ok: false, error }` 结构，简化错误处理
- 状态管理：Zustand + Immer（`auth.store` 保存 `adminInfo` / `theme.store` 保存主题），
  `main/layout.tsx` SSR 预取管理员信息
- 首个管理员：`pnpm seed:admin`（默认 `admin@billy.local / admin123`，可用
  `ADMIN_EMAIL` / `ADMIN_PASSWORD` 覆盖），随后可在「系统设置 → 管理员管理」中维护

## @repo/ui 的设计系统（token / 主题 / 字体规范）

`packages/ui/src/globals.css` 是 web 与 admin 共用的**视觉规范唯一定义处**：语义 token
（颜色 / 圆角，明暗各一套）、Tailwind 4 `@theme` 映射、字体族回退链、组件质感规则
（等宽数字对齐 / 细滚动条）。**token 没有 JS 副本** —— 具体值就是这些 CSS 变量本身，
页面里用 Tailwind 语义类消费；内联 style / SVG 场景直接写 `var(--primary)`
（理由见 [design-system.md](../design/design-system.md) §4.2）。

- 语义色：`primary` / `secondary` / `muted` / `accent` / `destructive` / `success` /
  `warning` / `info` / `brand`（品牌强调色，前台落地页用）/ `chart-1..5` / `sidebar-*`
  （共 38 个颜色 token，明暗对称）；
- 主题：三态（浅色 / 深色 / 跟随系统）能力在 ui 包 —— `createTheme({ storageKey })` 出
  `useTheme` / `initTheme`，`createThemeBootScript()` 生成防刷新白闪的内联脚本，
  `ThemeToggle` 是受控展示组件；**存储 key 由各 app 传**（同域部署下 front/back 互不干扰）；
- 守卫：`packages/ui/test/tokens.test.ts` 用**零手工清单**的纯 CSS 自洽断言守着
  「明暗对称 + `@theme` 映射自洽 + 字体回退链」；`pnpm check:ui` 拦新增硬编码调色板、
  校验样式入口可解析与字体规范一致；
- 设计决策、取舍依据与已知缺口见 [design-system.md](../design/design-system.md)，
  admin 应用层约定见 [admin-design-language.md](../design/admin-design-language.md)。

## @repo/ui — 共享组件库

shadcn 风格的组件实现统一在 `src/components/ui/*`（61 个：button / dialog / table /
sidebar / toast / chart 等），Tailwind 4 主题变量来自同包的 `globals.css`（设计系统）。
重型组件按需从子路径引入（`@repo/ui/components/ui/command` 等）。

## @repo/ui 的管理端组件

我们自己的组件与 shadcn 分开存放：shadcn 组件在 `src/components/ui/*`，
自有组件直接平铺在 `src/components/*`（与 ui/ 平级，不混入 shadcn 目录，避免被
`shadcn add` / registry 覆盖）。在 shadcn 基础组件之上提供管理端通用组件
（全部基于 **@tanstack/react-table** 与 **@tanstack/react-form**）：

- 表格：`DataTable`（@tanstack/react-table 列定义 + 服务端分页）/ `TableActions` /
  `ConfirmAction`（AlertDialog 确认）/ `PageToolbar`
- 列表：`DataList`（react-virtuoso 游标滚动加载）
- 表单：`ModalForm` / `DrawerForm` / `FormRenderer`（@tanstack/react-form 声明式
  items：widget + required/validate 校验）/ `EditableInput`
- 存储：`StorageProvider` / `StorageClientProvider`（把 SDK 客户端接到上传组件上，两个前端共用）/
  `useStorage` / `ImageUpload` / `FileUpload` / `FilePreview` / `SortableFileList`（配合 `/storage/*` 接口）
- 应用装配：`QueryProviders`（QueryClient + 统一错误 toast，策略由 app 传）/
  `RouteError` / `RouteNotFound`（`app/error.tsx` / `not-found.tsx` 的版式，两个前端共用）/
  `createTheme` / `ThemeToggle`（主题，存储 key 由 app 传）
- 展示：`DictTag` / `DisplayValue` / `DisplayRender` / `Tag` / `Icon` / `IconText` /
  `PageLoading` / `Group` / `AutoSize` 等
- `action.ts`：`defineAction` / `callAction` —— Server Action 的 `{ ok, data } | { ok: false, error }`
  包装器，与 `useDisclosure` / `usePasteFiles` / `useRect` 等 hooks
