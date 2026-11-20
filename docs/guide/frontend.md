# 前端（Web 与 Admin）

> 两个独立入口共用一套设计系统与组件库：Web 面向 C 端，Admin 面向后台。
> 组件库与设计系统细节见本篇；布局与依赖规则见 [architecture.md](./architecture.md)。

## apps/web — Next.js 16 前台

面向 C 端的前台应用，使用 **Base UI + shadcn/ui**（来自 `@repo/ui`）与 Tailwind 4；
视觉取值（配色 / 圆角 / 字体回退链 / 组件质感规则）统一来自设计系统包 **`@repo/ui`**，
`src/app/globals.css` 只保留设计系统入口、`@source` 与前台专属的 `@keyframes`。

- 页面共 **13 个** `page.tsx`：`/`（首页）、`/account`（**个人中心**：账号资料）与 `/account/sessions`
  （**登录设备**：列表 + 单设备下线）、`/auth/{login,register,forgot-password,reset-password}`、
  `/comparison`（竞品调研，数据在 `lib/competitors.ts`）、
  `/markdown/{,basic,code,gfm,article}`（Markdown 渲染示例）
- 首页（`components/landing/*`）：Hero → 事实横带 → 技术栈滚动 → **AI 能力**（对话 / 工具）→ 可观测性 →
  设计系统 → 维护性 → 快速开始 → CTA；页面上的数字（内建工具 / Agent Skills / ai-elements）应与 README
  同一口径，改能力时两处一起改
- Server Actions（`actions/auth.actions.ts`）封装登录 / 注册 / 忘记密码 / 重置密码 / 登出，
  token 写入 httpOnly cookie
- `lib/server-client.ts`：调用 `@repo/sdk` 的 `createAppClients` 装配 HTTP 客户端（浏览器端单例 +
  服务端无状态客户端 + 凭证读写），本文件只注入 `tokenKey` / 两端地址 / 401 善后；
  `lib/constants.ts` 的地址解析走 `@repo/shared` 的 `createAppUrlConfig`（环境变量读取留在 app，
  `NEXT_PUBLIC_*` 需构建期替换，`SERVER_URL` 是运行时变量）；httpOnly cookie 在 `lib/auth-session.ts` 读取
- `providers/QueryProvider.tsx` 注入 TanStack Query（`QueryCache` / `MutationCache` 的 `onError` 统一 toast）；
  `providers/WebStorageProvider.tsx` 把 `@repo/ui` 的上传组件接到 `storage.getPresignedUrl`；
  `providers/ThemeProvider.tsx` 应用已存储 / 系统的主题（**前台已支持暗色**，入口在落地页头部与移动端抽屉）；
  `stores/theme` 保存主题状态
- 受保护路由**只有 `/account/*`**，两层守卫：`src/proxy.ts` 中间件（只查 cookie → 无 cookie 真实 307 到
  `/auth/login?next=`，`matcher` 只挂 `/account/:path*`）+ `app/account/layout.tsx` 的 SSR 会话校验；
  `?next=` 回跳经 `lib/redirect.ts` 过滤（防开放重定向）。用户体系开关（`AUTH_ENABLED=false`）不在 proxy 判断，
  避免每个受保护页多一次网络往返
- 应用级兜底：`app/error.tsx`（可重试）、`app/not-found.tsx`、`app/loading.tsx`
- `app/layout.tsx` 标记 `force-dynamic`：前端根 layout 统一动态渲染（每次请求 SSR，不做静态预渲染）
- `next.config.ts`：生产 `output: 'standalone'`（dev 不设，便于 `next dev`）、React Compiler、transpile `@repo/ui`、
  `allowedDevOrigins`（用 127.0.0.1 打开时 Next 16 会把 dev 资源当跨源拦掉）、`typescript.ignoreBuildErrors`
  （类型由 `pnpm typecheck` 兜）

## apps/admin — Next.js 16 管理后台

面向后台的管理应用，与前台同源使用 **@repo/ui**（shadcn/ui 风格 + 设计系统，完整深色模式），
表格用 **@tanstack/react-table**（`DataTable`）、表单用 **@tanstack/react-form**
（`ModalForm` / `DrawerForm` / `FormRenderer` 声明式 items），适合表格 / 表单 / 权限类页面。
登录使用**后台管理员**账号（`AdminEntity`，`/admin/*` 接口），与前台用户体系隔离。

### 路由树（**26 个** `page.tsx`）

```
/                                  → 重定向 /main/dashboard
/auth/login                        管理员登录
/main/dashboard                    控制台
/main/user-center                  用户中心（含「登录设备」区块）
/main/system/users                 用户管理
/main/system/admins                管理员管理
/main/monitor/status               监控状态
/main/monitor/live                 实时告警（SSE）
/main/monitor/metrics              监控指标
/main/monitor/logs                 告警记录
/main/monitor/rules                告警规则
/main/ai/models                    模型管理（供应商 / 模型）
/main/ai/usage                     网关用量
/main/ai/keys                      上游 Key
/main/ai/skills                    技能库
/main/ai/memories                  记忆
/main/ai/files                     文件管理（跨会话列表 / 预览 / 分享）
/main/ai/workspaces                工作区
/main/ai/capabilities              能力服务（勾选外部服务 → 页面级「授权」）
/main/ai/authorizations            ⤶ 旧入口，重定向到 /main/ai/capabilities
/main/ai/skills/grants             ⤶ 旧入口，重定向到 /main/ai/skills
/main/ai/audit                     审计与复盘（调用审计 + 用量）
/main/ai/chat/[conversationId]     会话工作台（/main/ai/chat/new 为「新会话」保留段）
/main/ai/skills/[skillKey]         沉浸式技能编辑器（画布布局）
/s/[token]                         免授权分享页（独立 root layout）
/main/ai/tools                     ⤶ 旧入口，重定向到 /main/ai/capabilities
/main/ai/chat                      ⤶ 旧入口，重定向到 /main/ai/chat/new
```

- 侧栏 AI 组 **11 项**：`models` / `usage` / `keys` / `skills` / `market` / `memories` / `files` /
  `workspaces` / `credentials` / `capabilities` / `audit`；授权不单独占菜单（技能库 / 能力服务里勾选后授权）；
  会话工作台走**顶层「会话」分区**（不在侧栏 AI 组里）；技能编辑器从技能库点进去
- 菜单单一来源 `components/AppMenu.tsx`：控制台 / AI（11 项）/ 运维监控（5 项）/ 系统设置（2 项），
  系统设置项按用户体系开关 `authRequired` 隐藏
- 免授权分享页 `/s/[token]` 走独立 root layout（`(share)` 路由组），不挂 `Providers`、带
  `noindex` / `no-referrer`；`/main/ai/files` 文件列表页的 `ShareDialog` 生成链接（明文 token 只显示一次，
  库里只存哈希，有效期由 `DateTimePicker` 选，可撤销）。分享页只在 admin，web 没有
- 实时告警页把 SSE 链路走通：`client.createStream()`（`@repo/sdk`）→ `useStream`（`@repo/ui`）
  → 告警发送后 `StreamHub.publish('admin:all', 'alert.fired')` 实时到达；页内「触发测试告警」
  可一键自检全链路（协议与频道权限见 `stream` skill 与 `docs/design/frontend-foundation.md`）

### 布局与鉴权

- **两棵带 `<html>` 的 root layout**：`(app)` 与 `(share)`（路由组不产生 URL 段）。
  `(app)/layout.tsx` 装 `Providers` 与主题引导脚本，`(app)/auth/layout.tsx` 是登录页两栏版式。
- **三棵布局树共用全局顶栏**：管理台外壳 `main/layout.tsx`（`AppTopBar` + `SidebarProvider` + `AppSider` +
  `AppHeader`）、会话页 `(app)/(standalone)/main/layout.tsx`、技能编辑器 `(app)/(canvas)/main/layout.tsx`。
  三者都挂同一条 `AppTopBar`（顶层菜单只有「会话 / 管理」两项，判据在 `lib/sections.ts`），
  并复用**同一份** `AdminAuthBoundary`（路由组不产生 URL 段，地址仍是 `/main/ai/chat/**`、
  `/main/ai/skills/[skillKey]`）。
- 鉴权收在 `AdminAuthBoundary`（SSR 读 cookie 调 `admin.getMe()`，失败 `redirect()` 到登录页）：
  **它只 SSR 注入管理员身份**，布局里**不做业务数据 Query 预取** —— 业务数据一律客户端 TanStack Query。
  所有相关 layout 都标 `force-dynamic`（读 cookie）。
- 需要服务端推送的有两处：实时告警页（`/sse/subscribe`）与 AI 会话工作台（`/agent/chat/stream`），
  都走 SSE 长连接；其余页面的实时性靠 TanStack Query 的轮询 / 失效刷新。

### API 层、守卫与预览

- API 层：`app/api/[[...route]]/route.ts` 用 `@hono/vercel` 的 `handle(app)` 挂住全部 `/api/**`
  （`nodejs` runtime）；`src/api/app.ts` 设 `basePath='/api'` 与安全响应头（`no-referrer` / `SAMEORIGIN` 等），
  `src/api/share.ts` 提供 `GET|HEAD /api/s/:token/content`——按 token 向 server 换预签名 URL 后流式转发
  （透传 Range / HEAD），浏览器看不到 OSS 地址；新增接口只改 `src/api/*`
- 路由守卫：`proxy.ts` 中间件先调 `/config/get` 取用户体系开关（关闭时跳过守卫），再按
  `PublicPaths` + cookie 判断，未登录访问非公开页时 `redirect()` 到登录页
  （不对已登录用户做反向重定向）；`matcher` 排除 `api`、`s/`、Next 静态资源与元数据路由、
  `monaco/`（分享链接本身就是凭证）
- Server Actions：`actions/auth.actions.ts` 用 `@repo/ui/action` 的 `defineAction` / `callAction` 统一返回
  `{ ok, data } | { ok: false, error }` 结构，简化错误处理
- 预览：`components/file-preview-dialog.tsx`（`FilePreview` + Monaco 代码高亮 + Office 预览 + 全屏 +
  复制 / 下载）；**Monaco 走本地静态资源** —— `scripts/copy-monaco.mjs` 在 `next build` 前把
  `monaco-editor/min/vs` 拷到 `public/monaco/vs`（约 20MB，不进 git）
- 状态管理：Zustand + Immer（`auth.store` 每请求实例化、`theme.store` 保存主题）；
  `providers/AppProviders.tsx` 的装配顺序：`TooltipProvider → OverlayScrollbar → QueryProviders →
  StorageClientProvider → Toaster`（后台不设 `staleTime`，默认每次视为过期）
- 首个管理员：`pnpm seed:admin`（默认 `admin@billy.local / admin123`，可用
  `ADMIN_EMAIL` / `ADMIN_PASSWORD` 覆盖），随后可在「系统设置 → 管理员管理」中维护

## @repo/ui 的设计系统（token / 主题 / 字体规范）

`packages/ui/src/globals.css` 是 web 与 admin 共用的**视觉规范唯一定义处**：语义 token
（颜色 / 圆角，明暗各一套）、Tailwind 4 `@theme` 映射、字体族回退链、组件质感规则
（等宽数字对齐 / 细滚动条）。token 分两层：**原始层**（面 / 前景 / 主色 / 品牌 / 语义色 / 圆角）与
**派生层**（一律 `var()` 引用上层，不抄字面量）——换品牌色只需改 `--brand` 与 `--primary`，
sidebar / chart / 强调面自动跟随。**token 没有 JS 副本** —— 具体值就是这些 CSS 变量本身，
页面里用 Tailwind 语义类消费；内联 style / SVG 场景直接写 `var(--primary)`
（理由见 [design-system.md](../design/design-system.md) §4.2）。

- 语义色：`background` / `foreground` / `card` / `popover` / `primary` / `secondary` / `muted` /
  `accent` / `destructive` / `success` / `warning` / `info` / `brand`（品牌强调色，前台落地页用）/
  `border` / `input` / `ring` / `surface-1..4`（面层微色阶）/ `chart-1..5` / `sidebar-*`；
  `@theme inline` 共 **42 条颜色 token 映射**（明暗对称，sidebar / chart 派生自 `--brand`）
- 主题：三态（浅色 / 深色 / 跟随系统）能力在 ui 包 —— `createTheme({ storageKey })` 出
  `useTheme` / `initTheme`，`createThemeBootScript()` 生成防刷新白闪的内联脚本，
  `ThemeToggle` 是受控展示组件；**存储 key 由各 app 传**（同域部署下 front/back 互不干扰）
- 守卫：`packages/ui/test/tokens.test.ts` 用**零手工清单**的纯 CSS 自洽断言守着
  「明暗对称 + `@theme` 映射自洽 + 字体回退链」；`pnpm check:ui` 5 条不变量：
  **A** 自有组件导出完整性（`src/components/*` 每个文件都要在 `src/index.ts` 导出）/
  **B** 依赖 `next` 的前端包必须声明 `typecheck` 脚本 /
  **C** 禁止新增硬编码调色板类（存量按文件记基线，只许减少）/
  **D** 工作区包样式入口可解析 /
  **E** `next/font` 变量名与设计系统字体回退链一致
- 设计决策、取舍依据与已知缺口见 [design-system.md](../design/design-system.md)，
  admin 应用层约定见 [admin-design-language.md](../design/admin-design-language.md)。

## @repo/ui — 共享组件库

shadcn 风格的组件实现统一在 `src/components/ui/*`（**61 个**：button / dialog / table /
sidebar / toast / chart / command / carousel 等），Tailwind 4 主题变量来自同包的 `globals.css`（设计系统）。
另有 **48 个** `ai-elements` 组件（会话 / 工具调用 / 推理 / 文件附件等聊天 UI，另有 `markdown-fences/` 辅助），
单文件体量大、依赖重，**不进 barrel**，按需从 `@repo/ui/components/ai-elements/<name>` 子路径引入
（否则任何 `import { X } from '@repo/ui'` 都会把整棵 AI 组件树拉进首屏包）。
重型基础组件同样按需从子路径引入（`@repo/ui/components/ui/command` 等）。

## @repo/ui 的管理端组件

我们自己的组件与 shadcn 分开存放：shadcn 组件在 `src/components/ui/*`，
自有组件直接平铺在 `src/components/*`（与 ui/ 平级，不混入 shadcn 目录，避免被
`shadcn add` / registry 覆盖），共 **39 个**文件（含 `toast.ts` 与 `use-storage*` 两个 hook 文件）。
在 shadcn 基础组件之上提供管理端通用组件
（表格基于 **@tanstack/react-table**，表单基于 **@tanstack/react-form**）：

- 表格：`DataTable`（@tanstack/react-table 列定义 + 服务端分页）/ `TableActions` /
  `ConfirmAction`（AlertDialog 确认）/ `PageToolbar` / `RefreshButton`
- 列表：`DataList`（react-virtuoso 游标滚动加载）
- 表单：`ModalForm` / `DrawerForm` / `FormRenderer`（@tanstack/react-form 声明式
  items：widget + required/validate 校验）/ `EditableInput` / `DictSelect` / `TagsInput`
- 日期：`DateTimePicker` / `DateRangePicker`（基于 `Calendar`；分享有效期、文件列表时间筛选都走它，
  不要退回原生 `input type="date"`）
- 存储：`StorageProvider` / `StorageClientProvider`（把 SDK 客户端接到上传组件上，两个前端共用）/
  `useStorage` / `useStorageUrl` / `ImageUpload` / `FileUpload` / `FilePreview` / `SortableFileList` /
  `PromptAttachments`（配合 `/storage/*` 接口）
- 预览：`FilePreview`（图片 / 音视频 / 文本 / PDF 内嵌，其余给打开与下载）/ `ImageLightbox` /
  `Markdown` / `JsonView`；Office（docx / xlsx / pptx）预览与分享弹窗在 admin 应用层
  （`apps/admin/src/components/file-preview-dialog.tsx` / `share-dialog.tsx`），不放进 ui 包
- 应用装配：`QueryProviders`（QueryClient + 统一错误 toast，策略由 app 传）/
  `RouteError` / `RouteNotFound`（`app/error.tsx` / `not-found.tsx` 的版式，两个前端共用）/
  `createTheme` / `ThemeToggle`（主题，存储 key 由 app 传）/ `OverlayScrollbar`
- 展示：`DictTag` / `DisplayValue` / `DisplayRender` / `Tag` / `Icon` / `IconText` / `UserAvatar` /
  `PageLoading` / `Group` / `AutoSize` 等
- `action.ts`：`defineAction` / `callAction` —— Server Action 的 `{ ok, data } | { ok: false, error }`
  包装器；另有 `hooks/` 下的 `useDisclosure` / `usePasteFiles` / `useRect` / `useStream` / `useMobile`
  等通用 hooks
