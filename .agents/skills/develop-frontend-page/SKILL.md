---
name: develop-frontend-page
description: 在 Billy 工程中开发前端页面：Admin 后台页（@repo/ui 的 DataTable / DataList / ModalForm / Markdown 文档渲染 / 存储组件 + TanStack Query + TanStack Table/Form）与 Web 前台页（Base UI + shadcn + Tailwind 4 + Server Actions + useActionState）。触发词：前端页面、后台页面、列表页、表单页、写页面、组件、markdown、文档渲染、Server Action、ui、DataTable、ModalForm、shadcn、Tailwind、TanStack。
---

# 开发前端页面

前置：先加载必读 skill `billy-dev-foundation`（「不重复造轮子」实现查找顺序见其
`references/code-conventions.md` 第 10 条：先查 `@repo/ui` 与依赖包，
有现成组件绝不自写）。涉及新接口时加载 `develop-business-module`。

## 两套前端，同一 UI 包

| | Web 前台（`apps/web`，9840） | Admin 后台（`apps/admin`，9845） |
| --- | --- | --- |
| 定位 | C 端页面 | 管理端页面 |
| UI 基础 | `@repo/ui`（Base UI + shadcn 风格）+ Tailwind 4 | `@repo/ui`（同源，含 DataTable / ModalForm 等管理组件）+ Tailwind 4 |
| 表格 / 表单 | —（营销页为主） | `@tanstack/react-table`（DataTable）+ `@tanstack/react-form`（ModalForm / DrawerForm / FormRenderer） |
| 状态 | TanStack Query + Server Actions | TanStack Query + Zustand/Immer + Server Actions |
| 典型页面 | `/`、`/auth/login`、`/auth/register` | `/main/*`（dashboard / todo / system/users 等） |

**两套前端统一使用 `@repo/ui`（shadcn/ui 风格）**。

**组件目录约定（硬性）**：`@repo/ui` 的 `components/ui/*` 是 shadcn 管理的目录
（用 shadcn CLI 增删组件，保留其文件，需要时可直接更新其内容）；**自有封装一律放
`components/*`**（如 data-table / modal-form / markdown / dict-select），严禁把自封装
组件放进 `components/ui/*`。新增组件后在 `packages/ui/src/index.ts` 的「自有组件」区段导出。

**样式约定（硬性）——优先使用 className**：调整组件 / 页面视觉时，能传 className 的
一律传 className（shadcn 组件不可改时，在**业务组件或页面**里通过 `cn`/`tailwind-merge`
传入覆盖，如 `AppMenu` 的菜单间距、`DataTable` 的表头样式）。**不要用 CSS 覆盖**
shadcn 组件的默认类：Tailwind 的 utilities 层声明在 base 之后，写在 `@layer base` 内的
覆盖会被 utilities 层压过而不生效（层顺序优先于选择器特异性）。只有无法用 className
实现时才写 CSS（如 `::before` 伪元素、全局滚动条），且**必须写在 `@layer` 之外**
（非 layer 规则优先于所有 layer，含 utilities）。参考实现：
`apps/admin/src/app/globals.css`（仅保留激活指示条 / 主按钮 hover / 滚动条等必要规则）、
`apps/admin/src/components/AppMenu.tsx`（间距全用 className）。

**视觉 / 设计质量（门面型页面可借全局设计 skill）**：Web 前台 / 落地页等「门面型」视觉任务，
可**按需参考**全局设计 skill（`shadcn` / `design-taste-frontend` / `impeccable` /
`redesign-existing-projects` 等）提升审美与布局——它们只作设计参考，**不纳入本工程规范 / 必读**
（全局 skill 不受 git 管理、不可复现）。若某设计规范长期复用，按 `manage-skills` 的
`find-external-skill.md`「评估 → 适配 → 登记」沉淀为项目内 skill；最终仍统一遵循
`@repo/ui`（shadcn 风格）与本文的 className / @layer 样式约定。

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/admin-page.md](./references/admin-page.md) | Admin 页骨架、DataTable / DataList 选型、@tanstack/react-form 声明式表单、缓存同步、展示辅助、defineAction | 写 Admin 页面时（必读） |
| [references/web-page.md](./references/web-page.md) | Web 页 wrapAction + useActionState + @repo/ui 组件 | 写 Web 前台页面时（必读） |

## 菜单与路由

- admin：新页面放 `apps/admin/src/app/main/xxx/page.tsx`，并在 `AppMenu.tsx` 的 items 加菜单项
  （`key` 为路由路径，如 `/main/xxx`）。
- **两个前端的根 layout 统一动态渲染**：`apps/web/src/app/layout.tsx` 与 `apps/admin/src/app/layout.tsx`
  都标了 `export const dynamic = 'force-dynamic'`（每次请求 SSR，不做整站静态预渲染）——新页面不要依赖
  构建期静态数据 / 预渲染缓存。
- admin 守卫已由 `proxy.ts`（cookie 重定向）+ `main/layout.tsx`（SSR `getMe()` 鉴权）统一处理，
  新页面无需重复；`force-dynamic` 的 layout 下不要缓存用户态数据。
- web：目前无 proxy 路由守卫（`apps/web/src/lib/constants.ts` 只定义 `Pages` / `TokenKey` 等常量）；
  auth 页公开，受保护逻辑按需在对应 layout / action 内做，勿臆造不存在的 `PublicPaths`。

## 完成检查清单

- [ ] 已按「实现查找顺序」确认 `@repo/ui` / 依赖包无现成组件可复用（不重复造轮子）
- [ ] 两套前端统一从 `@repo/ui` 取组件
- [ ] 列表用 `DataTable`（页码，@tanstack/react-table）或 `DataList`（游标）之一，数据源来自 SDK 类型化方法
- [ ] 增删改走 `useMutation` + `toastSuccess` + 缓存同步（refetch 或 immer 就地更新）
- [ ] 表单用 `ModalForm` / `DrawerForm` 声明式 items（@tanstack/react-form），onSubmit 写在 `useForm` 里
- [ ] 字典列用 `DictTag` / `getLabel`；时间用 `DisplayValue`；文件用 `formatStorageUrl`
- [ ] Server Actions 统一走 `defineAction`（admin）或 `wrapAction`（web）的错误处理封装
- [ ] admin 新页面已登记 `AppMenu.tsx` 菜单
- [ ] 样式调整优先用组件 className；必须写 CSS 覆盖时写在 `@layer` 之外（非 layer 优先）
