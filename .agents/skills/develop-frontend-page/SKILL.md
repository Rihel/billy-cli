---
name: develop-frontend-page
description: 在 Billy 工程中开发前端页面：Admin 后台页（@repo/ui 的 DataTable / DataList / ModalForm / Markdown 文档渲染 / 存储组件 + TanStack Query + TanStack Table/Form）与 Web 前台页（Base UI + shadcn + Tailwind 4 + Server Actions + useActionState），视觉取值统一走 @repo/ui 的设计系统 token。触发词：前端页面、后台页面、列表页、表单页、写页面、组件、markdown、文档渲染、Server Action、ui、DataTable、ModalForm、shadcn、Tailwind、TanStack、设计系统、design token、主题、token。
---

# 开发前端页面

前置：先加载必读 skill `billy-dev-foundation`（「不重复造轮子」实现查找顺序见其
`references/code-conventions.md` 第 10 条：先查 `@repo/ui` 与依赖包，
有现成组件绝不自写）。涉及新接口时加载 `develop-business-module`。

## 两套前端，同一 UI 包 + 同一设计系统

| | Web 前台（`apps/web`，9840） | Admin 后台（`apps/admin`，9845） |
| --- | --- | --- |
| 定位 | C 端页面 | 管理端页面 |
| UI 基础 | `@repo/ui`（Base UI + shadcn 风格）+ Tailwind 4 | `@repo/ui`（同源，含 DataTable / ModalForm 等管理组件）+ Tailwind 4 |
| 表格 / 表单 | —（营销页为主） | `@tanstack/react-table`（DataTable）+ `@tanstack/react-form`（ModalForm / DrawerForm / FormRenderer） |
| 状态 | TanStack Query + Server Actions | TanStack Query + Zustand/Immer + Server Actions |
| 典型页面 | `/`、`/auth/login`、`/auth/register` | `/main/*`（dashboard / system/users 等） |

**两套前端统一使用 `@repo/ui`（shadcn/ui 风格）与 `@repo/ui`（设计系统：token / 主题 /
字体规范 / 组件质感）**。

**组件目录约定（硬性）**：
- `components/ui/*` 是 shadcn 管理的目录（用 shadcn CLI 增删，保留其文件，需要时可直接更新内容）；
- **自有封装一律放 `components/*`**（data-table / modal-form / markdown / dict-select 等），
  严禁把自封装组件放进 `components/ui/*`；新增后在 `packages/ui/src/index.ts` 的「自有组件」区段导出；
- **`components/ai-elements/*` 是 AI 会话专用的子路径区**（48 个上游组件，见
  `docs/design/ai-agent.md` §1）：**不进 barrel**（体积大、按需引入），`check:ui` 与 `components/ui/*`
  同样豁免 barrel 检查。引入方式**必须带扩展名**（`exports` 的通配映射不做扩展名补全）：
  ```tsx
  import { Message, MessageContent, MessageResponse } from '@repo/ui/components/ai-elements/message.tsx'
  ```
  两处**本地改造**（改上游文件，改之前先看这里的理由）：
  - **发送键可配**：`PromptInputTextarea` 多一个 `submitOn="enter" | "mod+enter"`（默认保持上游的
    Enter 语义）；管理台用 `mod+enter`（长文本下"回车即发送"太容易误发）；
  - **附件带原件**：`PromptInputMessage.files` 的每一项多一个 `rawFile`（`PromptInputFilePart`）——
    `FileUIPart` 只有一个 `url`，而调用方常常需要原始 `File`（按内容算 md5、直传对象存储）。
    附件校验**不要依赖 `maxFileSize` / `accept`**：`accept` 只提示文件选择框（粘贴不过它），
    `maxFileSize` 是"一个超限整批丢"的粗粒度行为 —— 提交前自己逐文件预检并逐个说明原因。
  - 待发附件条用 `PromptInputAttachmentsBar`（必须放在 `<PromptInput>` 内部），
    已发送消息里的附件用 `PromptAttachments`（`@repo/ui` 的 `components/prompt-attachments.tsx`，走 barrel）；
  - **点击上传**用 `PromptInputAttachmentButton`（也是本地新增：上游只把这个入口放在"加号菜单"里，
    而"点一下就能选文件"是对话界面的默认预期）；粘贴上传是 `PromptInput` 自带的。
  - 附件能不能发，看**当前模型的 `inputModalities`**（模型实体字段，见 `AiModality`）：
    `null` = 未声明（提醒但不拦）、`[]` / 只有 `text` = 明确不支持（拦下并说清）。

  - **富内容围栏**在 `components/ai-elements/markdown-fences/`：`xflow`（JSON → React Flow，画布按需加载）、
    `html` / `gsap`（沙箱 iframe，`sandbox="allow-scripts"` 不带 same-origin + 文档内 CSP 禁网）；
    注册表是 `markdownFenceRenderers`，`message.tsx` 已接进 Streamdown 的 `plugins.renderers`。
    加一种新围栏 = 写组件 + 注册 + 改 `requirements.eta`；围栏**没闭合时只渲染占位**（靠 `MessageResponse`
    的 `isAnimating`），别为了"看起来实时"改成每个 token 重渲染 —— iframe 会反复重跑脚本、图会来回跳。
    设计见 `docs/design/ai-markdown-fences.md`。
  - **展示 JSON 一律用 `JsonView`**（`@repo/ui` 的 `components/json-view.tsx`，走 barrel）：可折叠的树、
    容器带字段/项数摘要、原文/树形切换与复制、对超大内容有上限。**不要** `<pre>{JSON.stringify(v, null, 2)}</pre>`
    —— 后台的告警快照、审计请求快照、时间线 payload、工具入参/出参、参数定义都已换成它；
    `<pre>` 只留给非结构化文本（命令行输出、日志片段）。

  这些组件**不读 `message.parts`** —— 状态由调用方从 part 里取出来当 props 传（映射写法见
  `apps/web/src/app/ai/chat/page.tsx`）。

## 弹窗表单回填（硬性）—— 走 `ModalForm` 的 `values`

`ModalForm` / `DrawerForm` 的回填入口是 **`values` 属性**（内部用 `form.setFieldValue` 逐字段写，
注释里写明这是为了**绕开 tanstack `reset` 在弹窗场景的渲染同步问题**）。
**不要**用 `openEditXxx` 里 `form.reset(...)` 当回填手段 —— 值会进 store 但界面不跟着变，
表现就是"编辑弹窗打开后**所有字段都是空的**"（2026-10-07 踩过）。

- 编辑：`values={editDialog.data ? { ...从 data 映射字段 } : undefined}`；
- 新建：不传 `values`，吃表单的 `defaultValues`；
- `null` 要转成 `undefined`：`ModalForm` 只写**非 undefined** 的字段，传 `null` 会被跳过，
  于是表单留着上一次的值（比空更糟）。

回归防线：`packages/ui/test/modal-form-backfill.test.tsx`（给 `values` 就要真的显示出来；
破坏回填它立刻变红）。

## 设计系统（硬性）—— 视觉取值只走语义 token

token / 主题 / 字体回退链 / 组件质感的**唯一定义处**是 `@repo/ui`
（`packages/ui/src/globals.css`，web 与 admin 共用）。完整清单、守卫与取舍依据见
[`docs/design/design-system.md`](../../../docs/design/design-system.md)。

- 页面与组件里写 Tailwind **语义类**：`bg-primary` / `text-muted-foreground` / `text-success` /
  `border-border` / `rounded-lg`；**不写** `bg-blue-500` / `text-zinc-400` 这类调色板类
  （`pnpm check:ui` 会拦新增，存量按文件基线冻结）。
- app 的 `src/app/globals.css` **只留四行接入 + `@source` + 该 app 专属的 `@keyframes`**：
  `@import "tailwindcss"` / `@import "@repo/ui/globals.css"` /
  `@import "tw-animate-css"` / `@import "shadcn/tailwind.css"`。
  **不要在 app 里另定义 token / 字体回退链 / 全局滚动条** —— 加样式前先想
  「这是不是跨端共享的」（是 → 放 `packages/ui/src/globals.css`）。
- **token 没有 JS 副本**：具体值就是那些 CSS 变量本身，页面里用 Tailwind 语义类消费；
  拿不到类的场景（图表 / SVG / 内联 style）直接写 `var(--chart-1)`，随明暗自动切换。
- **主题（浅色 / 深色 / 跟随系统）能力在 `@repo/ui`**：app 侧只写
  `createTheme({ storageKey: 本应用的 ThemeKey })`（出 `useTheme` / `initTheme`）+ 根 layout 用
  `createThemeBootScript({ storageKey })` 生成防刷新白闪的内联脚本。**存储 key 必须各 app 不同**
  （同域部署 localStorage 共享，否则前后台互相改主题）；页面视觉取值只用语义 token，
  硬编码调色板在暗色下必然出错（`pnpm check:ui` 会拦）。
- 字体：app 的 `layout.tsx` 里 `next/font` 的 `variable` **必须写字面量**
  （框架要求，传变量直接构建失败）；数据结构放在 `globals.css` 的字体回退链里，
  `pnpm check:ui` 第 ⑤ 条从 CSS 推导并校验两侧一致。
- 新增 / 修改 token 时：补 `@theme inline` 映射（格式必须是 `--color-X: var(--X)`）、
  补深色取值（明暗键集合必须完全一致）；`packages/ui/test/tokens.test.ts` 会拦下
  漏映射、映射指向别处、只写浅色这三类静默事故。

**样式约定（硬性）—— 优先使用 className**：调整组件 / 页面视觉时，能传 className 的
一律传 className（shadcn 组件不可改时，在**业务组件或页面**里通过 `cn`/`tailwind-merge`
传入覆盖，如 `AppMenu` 的菜单间距、`DataTable` 的表头样式）。**不要用 CSS 覆盖**
shadcn 组件的默认类：Tailwind 的 utilities 层声明在 base 之后，写在 `@layer base` 内的
覆盖会被 utilities 层压过而不生效（层顺序优先于选择器特异性）。只有无法用 className
实现时才写 CSS（如 `::before` 伪元素、全局滚动条），且**必须写在 `@layer` 之外**
（非 layer 规则优先于所有 layer，含 utilities）—— 跨端共享的这类规则放 `@repo/ui`，
app 专属的才留在 app。参考实现：
`packages/ui/src/globals.css`（等宽数字对齐 / 滚动条等全局规则）、
`apps/admin/src/components/AppMenu.tsx`（间距全用 className）。

**视觉 / 设计质量（展示型页面可借全局设计 skill）**：Web 前台 / 落地页等「展示型」视觉任务，
可**按需参考**全局设计 skill（`shadcn` / `design-taste-frontend` / `impeccable` /
`redesign-existing-projects` 等）提升审美与布局——它们只作设计参考，**不纳入本工程规范 / 必读**
（全局 skill 不受 git 管理、不可复现）。若某设计规范长期复用，按 `manage-skills` 的
`find-external-skill.md`「评估 → 适配 → 登记」沉淀为项目内 skill；最终仍统一遵循
`@repo/ui`（shadcn 风格）与本文的 className / @layer / 语义 token 约定。

## 前端质量检查（写完页面必跑）

与后端对等，前端也有可执行的门（命令说明见
`billy-dev-foundation/references/commands.md`）：

```bash
pnpm typecheck   # turbo：web / admin / ui / design 四包 tsc --noEmit
pnpm test        # turbo：七包单测（ui 用 jsdom + testing-library，design / 两个 app 用 node 环境）
pnpm check:ui    # 守卫四条：组件导出 / 前端包 typecheck 脚本 / 禁止新增硬编码调色板 /
                 #   app 与 @repo/ui 的样式入口可解析 / next/font 变量名与设计系统规范一致
```

- 新增前端包**必须声明 `typecheck` 脚本**，否则守卫拦下。
- 纯逻辑（常量 / 格式化 / 守卫判定）写 `test/*.test.ts` 用 node 环境；hook / 组件写 jsdom 用例，
  样板见 `packages/ui/test/{tag.test.tsx,use-stream.test.ts}`。写法见 `write-tests` skill。
- 改 `@repo/ui` 的自有组件目录时，别忘在 `packages/ui/src/index.ts` 补导出（守卫会拦）。
- 改 `@repo/ui` 的 token / 字体规范后，跑 `pnpm --filter @repo/ui test`（守卫会拦不对称与漏映射）。

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/admin-page.md](./references/admin-page.md) | Admin 页骨架、DataTable / DataList 选型、@tanstack/react-form 声明式表单、缓存同步、展示辅助、defineAction、实时页面（SSE） | 写 Admin 页面时（必读） |
| [references/web-page.md](./references/web-page.md) | Web 页 defineAction + useActionState + @repo/ui 组件、受保护页面两层守卫、前台全局装配 | 写 Web 前台页面时（必读） |

## 菜单与路由

- admin：新页面放 `apps/admin/src/app/main/xxx/page.tsx`，并在 `AppMenu.tsx` 的 items 加菜单项。
  **例外（全窗口工作台类页面）**：需要脱离管理台外壳（无左侧菜单 / 无页头）、又不想改 URL 时，
  放到路由组下并自带 layout —— 见 `apps/admin/src/app/(standalone)/main/layout.tsx`（AI 会话页就是这么做的：
  路由组不产生 URL 段，地址仍是 `/main/ai/chat/...`）；**鉴权必须复用 `components/AdminAuthBoundary.tsx`**，
  并自己导出 `dynamic = 'force-dynamic'`，别忘了给页面一个「回管理台」入口（外壳导航没了）
  （`key` 为路由路径，如 `/main/xxx`）。
- **两个前端的根 layout 统一动态渲染**：`apps/web/src/app/layout.tsx` 与 `apps/admin/src/app/layout.tsx`
  都标了 `export const dynamic = 'force-dynamic'`（每次请求 SSR，不做整站静态预渲染）——新页面不要依赖
  构建期静态数据 / 预渲染缓存。
- admin 守卫已由 `proxy.ts`（cookie 重定向）+ `main/layout.tsx`（SSR `getMe()` 鉴权）统一处理，
  新页面无需重复；`force-dynamic` 的 layout 下不要缓存用户态数据。
- web：受保护页在 `apps/web/src/proxy.ts` 的 `config.matcher` 里登记前缀（无 cookie → 真实 307 到
  登录页并带 `?next=`），会话有效性由该区 `layout.tsx` 的 SSR 校验兜底；登录 / 注册页用
  `resolveNextPath`（`apps/web/src/lib/redirect.ts`）过滤回跳地址。参考 `/account`。

## 完成检查清单

- [ ] 已按「实现查找顺序」确认 `@repo/ui` / 依赖包无现成组件可复用（不重复造轮子）
- [ ] 两套前端统一从 `@repo/ui` 取组件
- [ ] 列表用 `DataTable`（页码，@tanstack/react-table）或 `DataList`（游标）之一，数据源来自 SDK 类型化方法
- [ ] 增删改走 `useMutation` + `toastSuccess` + 缓存同步（refetch 或 immer 就地更新）
- [ ] 表单用 `ModalForm` / `DrawerForm` 声明式 items（@tanstack/react-form），onSubmit 写在 `useForm` 里
- [ ] 字典列用 `DictTag` / `getLabel`；时间用 `DisplayValue`；文件用 `formatStorageUrl`
- [ ] Server Actions 统一走 `defineAction`（`@repo/ui/action`，两个前端同一套 `{ ok }` 结果约定）
- [ ] admin 新页面已登记 `AppMenu.tsx` 菜单
- [ ] 需要登录态的前台页：已加进 `apps/web/src/proxy.ts` 的 `matcher`（真实 307）+ layout 做 SSR 会话校验 + `?next=` 经 `lib/redirect.ts` 过滤
- [ ] 用到上传 / toast / Query：确认 `<Toaster />` 与存储 Provider（web `WebStorageProvider` / admin `AppProviders`）已装配
- [ ] 实时页面用 `client.createStream()` + `useStream`（`useMemo` 稳定引用），事件负载用共享 schema 解析
- [ ] 已跑 `pnpm typecheck` / `pnpm test` / `pnpm check:ui`（新增前端包确认已声明 `typecheck` 脚本）
- [ ] 界面验证交回用户：列清「打开哪个页面、做什么操作、期望看到什么」，**不自己跑无头浏览器截图**
      （规则见 `billy-dev-foundation/references/workflow.md` 的「验证与收尾清理」）
- [ ] 视觉取值只用语义 token（不用 `bg-blue-500` 这类调色板类）；样式调整优先用组件 className；必须写 CSS 覆盖时写在 `@layer` 之外
