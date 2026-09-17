# Admin 端设计语言（应用层）

> **token / 主题 / 字体回退链 / 组件质感的定义已统一上移到 `@repo/ui`**（与组件库同包，
> web 与 admin 共用）。完整 token 清单、守卫与取舍依据见
> [`docs/design/design-system.md`](./design-system.md)；本文只记录 **admin 应用层**的
> 设计与交互约定，**不再重复定义任何 token**。

## 1. 定位与品牌

- **产品**：Billy Cli（一套模板，全栈直达），开发者工具。
- **受众**：开发者 / 运维 / 运营人员。
- **基调**：亮色优先 devtool 风（Linear / Vercel 式克制精确），完整深色模式。
- **视觉取值**（全部来自 `@repo/ui`）：主按钮**近黑**
  （浅色 `--primary: oklch(0.205 0 0)`，深色反白为近白），焦点环与点缀为**靛紫** `--ring`；
  语义状态色独立（success / warning / info / destructive），不与强调色混用。

> 本文此前写着「Azure 亮蓝主按钮」，那是早期方案的描述，**与代码实际取值不符**；
> 2026-09-17 已随设计系统落地修正。品牌色以 `packages/ui/src/globals.css` 为准。

## 2. 设计原则

1. **单一强调色**：强调色只做「品牌触点」（焦点环、激活态、图表首色），其余一律中性灰阶。
2. **命令行精确感**：mono 字体（Geist Mono）用于 ID / 数字 / 时间戳 / 路径 / 配置值，
   配合 `tabular-nums` 对齐 —— 该规则由 `@repo/ui` 全局提供，无需逐处声明。
3. **表面分层**：内容区 `--background`、卡片与侧边栏 `--card` / `--sidebar`、悬浮层 `--popover`；
   层次靠底色差 + 细边框 + 克制阴影，不做重投影。
4. **克制动效**：hover / active 过渡、激活指示条；无滚动炫技、无无限循环动画。
5. **可访问性**：按钮 / 表单 / 焦点环达 WCAG AA —— 语义色浅色档位取调色板 700 档正是为此；
   尊重 `prefers-reduced-motion`。

## 3. 壳组件（`apps/admin/src/components`）

- **AppSider**：logo = 靛紫渐变方块（`from-indigo-500 to-violet-600`）+ 字标 + mono 副标
  「admin console」；菜单激活态 = 浅色底 + 左侧 2px 指示条。
- **AppHeader**：左侧页面标题 + mono 路径（CLI 定位感）；右侧主题切换
  （浅色 / 深色 / 跟随系统，见 `ThemeToggle.tsx` 与 `stores/theme.store.ts`）。
- **登录页**：居中卡片 + 克制光晕背景，品牌区用同款渐变方块。
- **Dashboard**：真实数据统计卡（mono 数字）+ 快速入口 + 服务状态点。

## 4. 主题切换

- 存储键 `billy-admin-theme`（light / dark / system），默认跟随系统。
- `layout.tsx` 内联引导脚本在水合前设置 `.dark`，避免深色模式刷新闪烁（FOUC）。
- 系统偏好变化时 system 模式自动跟随；手动选择后以手动为准。

> 前台 `apps/web` **目前没有**主题切换 —— 它的样式尚未收敛到语义 token（存量硬编码仍在），
> 故只有 admin 会挂 `.dark`。收敛到 token 后才能获得暗色能力（见设计系统文档 §2「本轮不做」）。

## 5. 新增页面自查清单

- [ ] 用 `PageToolbar` + `DataTable` / `DataList` + `ModalForm` 等既有组件，不造新容器
- [ ] 视觉取值只用语义 token（`bg-primary` / `text-muted-foreground` / `text-success` …），
      不写 `bg-blue-500` 这类调色板类（`pnpm check:ui` 会拦新增）
- [ ] 数字 / ID / 时间 / 路径用 `font-mono`（`tabular-nums` 已由设计系统全局提供）
- [ ] 浅色与深色模式都过一遍（`ThemeToggle` 切换验证）
- [ ] 主按钮 / 表单 / 焦点环对比度达 AA
