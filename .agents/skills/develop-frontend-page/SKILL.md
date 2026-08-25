---
name: develop-frontend-page
description: 在 Billy 工程中开发前端页面：Admin 后台页（Ant Design 6 + @repo/aui 的 DataTable / DataList / ModalForm / 存储组件 + TanStack Query）与 Web 前台页（Base UI + shadcn + Tailwind 4 + Server Actions + useActionState）。触发词：前端页面、后台页面、列表页、表单页、写页面、组件、Server Action、aui、DataTable、ModalForm、shadcn、Tailwind。
---

# 开发前端页面

前置：先加载必读 skill `billy-dev-foundation`（「不重复造轮子」实现查找顺序见其
`references/code-conventions.md` 第 10 条：先查 `@repo/aui` / `@repo/ui` 与依赖包，
有现成组件绝不自写）。涉及新接口时加载 `develop-business-module`。

## 两套前端，先分清入口

| | Web 前台（`apps/web`，9840） | Admin 后台（`apps/admin`，9845） |
| --- | --- | --- |
| 定位 | C 端页面 | 管理端页面 |
| UI 基础 | `@repo/ui`（Base UI + shadcn 风格）+ Tailwind 4 | Ant Design 6 + `@repo/aui` |
| 状态 | TanStack Query + Server Actions | TanStack Query + Zustand/Immer + Server Actions |
| 典型页面 | `/`、`/auth/login`、`/auth/register` | `/main/*`（dashboard / todo / system/users 等） |

**不要串用组件**：web 不引 antd / aui；admin 不引 shadcn。

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/admin-page.md](./references/admin-page.md) | Admin 页骨架、DataTable / DataList 选型、ModalForm 声明式表单、缓存同步、aui 组件、defineAction | 写 Admin 页面时（必读） |
| [references/web-page.md](./references/web-page.md) | Web 页 wrapAction + useActionState + @repo/ui 组件 | 写 Web 前台页面时（必读） |

## 菜单与路由

- admin：新页面放 `apps/admin/src/app/main/xxx/page.tsx`，并在 `AppMenu.tsx` 的 items 加菜单项
  （`key` 为路由路径，如 `/main/xxx`）。
- admin 守卫已由 `proxy.ts`（cookie 重定向）+ `main/layout.tsx`（SSR `getMe()` 鉴权）统一处理，
  新页面无需重复；`force-dynamic` 的 layout 下不要缓存用户态数据。
- web：目前无 proxy 路由守卫（`apps/web/src/lib/constants.ts` 只定义 `Pages` / `TokenKey` 等常量）；
  auth 页公开，受保护逻辑按需在对应 layout / action 内做，勿臆造不存在的 `PublicPaths`。

## 完成检查清单

- [ ] 已按「实现查找顺序」确认 aui / ui / antd / Base UI 无现成组件可复用（不重复造轮子）
- [ ] 页面属于正确的入口（web 不引 antd，admin 不引 shadcn）
- [ ] 列表用 `DataTable`（页码）或 `DataList`（游标）之一，数据源来自 SDK 类型化方法
- [ ] 增删改走 `useMutation` + `message.success` + 缓存同步（refetch 或 immer 就地更新）
- [ ] 表单用 `ModalForm` 声明式 items；受控组件（ImageUpload 等）在 `render` 里接 value/onChange
- [ ] 字典列用 `DictTag` / `getLabel`；时间用 `DisplayValue`；文件用 `formatStorageUrl`
- [ ] Server Actions 统一走 `defineAction`（admin）或 `wrapAction`（web）的错误处理封装
- [ ] admin 新页面已登记 `AppMenu.tsx` 菜单
