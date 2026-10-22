# Admin 端设计语言（应用层）

> **token / 主题 / 字体回退链 / 组件质感的定义已统一上移到 `@repo/ui`**（与组件库同包，
> web 与 admin 共用）。完整 token 清单、守卫与取舍依据见
> [`docs/design/design-system.md`](./design-system.md)；本文只记录 **admin 应用层**的
> 设计与交互约定，**不再重复定义任何 token**。

## 1. 定位与品牌

- **产品**：Billy Cli（一套模板，全栈直达），开发者工具。
- **受众**：开发者 / 运维 / 运营人员。
- **基调**：亮色优先 devtool 风（Linear / Vercel 式克制精确），完整深色模式。
- **视觉取值**（全部来自 `@repo/ui`）：页面底是带一丝冷调的中性灰（`--background`），
  卡片纯白浮起；主按钮**近黑**（浅色 `--primary`，深色反白为近白），品牌强调色**靛紫**
  `--brand` 负责侧栏激活态、品牌标记、图标色片与图表主色，焦点环 `--ring` 跟随它；
  语义状态色独立（success / warning / info / destructive），不与品牌色混用。

> 本文此前写着「Azure 亮蓝主按钮」，那是早期方案的描述，**与代码实际取值不符**；
> 2026-09-17 已随设计系统落地修正。品牌色以 `packages/ui/src/globals.css` 为准。

## 2. 设计原则

1. **单一强调色**：品牌色只做「品牌触点」（焦点环、侧栏激活态、品牌标记、图标色片、图表首色），
   其余一律中性灰阶；语义色只表达状态，不当装饰。
2. **命令行精确感**：mono 字体（Geist Mono）用于 ID / 数字 / 时间戳 / 路径 / 配置值，
   配合 `tabular-nums` 对齐 —— 该规则由 `@repo/ui` 全局提供，无需逐处声明。
3. **表面分层**：页面底 `--background`（冷调浅灰）→ 侧栏 `--sidebar`（沉一档的导轨）→
   卡片 `--card`（纯白）→ 悬浮层 `--popover`；层次靠面层明度差 + 极轻投影表达，
   不画结构边框、不做重投影。中性色本身带 0.004~0.008 的 chroma，避免零彩度灰发闷。
4. **克制动效**：hover / active 过渡、激活指示条；无滚动炫技、无无限循环动画。
5. **不用渐变**：背景 / 卡片 / 图表填充一律平涂；层次用面层明度差与极轻投影表达。
6. **可访问性**：按钮 / 表单 / 焦点环达 WCAG AA —— 语义色浅色档位取调色板 700 档正是为此；
   尊重 `prefers-reduced-motion`。

## 3. 壳组件（`apps/admin/src/components`）

- **AppSider**：logo = 品牌靛紫方块（`bg-brand`）+ 字标 + mono 副标「admin console」；
  菜单激活态 = 品牌色淡底（`--sidebar-accent`）+ 品牌前景色。
- **AppHeader**：左侧页面标题 + mono 路径（CLI 定位感）；右侧主题切换
  （浅色 / 深色 / 跟随系统，见 `ThemeToggle.tsx` 与 `stores/theme.store.ts`）。
- **登录页**：左栏品牌叙事 + 纯面色底，右侧白面表单卡；品牌标记同 `bg-brand`，不做装饰渐变。
- **Dashboard**：统计块 = 彩色图标色片 + 标签 + mono 大数字（浅色平涂 6%~7% 色块，深色退回中性面），
  AI 用量用柱状图 + 环图，服务状态用语义色胶囊。

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
