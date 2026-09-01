# Admin 端设计语言（Billy Admin Design Language）

> 生效范围：`apps/admin`。共享组件库 `@repo/ui` 保持 shadcn 默认 neutral，作为库默认；
> admin 在 `apps/admin/src/app/globals.css` 中覆盖全部主题 token，不影响 `apps/web` 前台。

## 1. 定位与品牌

- **产品**：Billy Cli（一套模板，全栈直达），开发者工具。
- **受众**：开发者 / 运维 / 运营人员。
- **基调**：浅色优先 devtool 风（Linear / Vercel 式克制精确），完整深色模式。
- **品牌色**：橙色，与前台 landing（`apps/web`，orange-500/600）保持一致。单一强调色，
  语义色（success / destructive / warning）独立，不与品牌色混用。

## 2. 设计原则

1. **单一强调色**：橙色只做「品牌触点」（主按钮、激活态、焦点环、logo），其余一律中性灰阶。
2. **命令行精确感**：mono 字体（Geist Mono）用于 ID / 数字 / 时间戳 / 路径 / 配置值，
   配合 `tabular-nums` 对齐；logo 用 CLI 提示符 `>` 方块。
3. **表面分层**：内容区浅灰（`--background`）、卡片与侧边栏纯白（`--card` / `--sidebar`）、
   悬浮层 `--popover`；层次靠底色差 + 细边框 + 克制阴影，不做重投影。
4. **克制动效**：hover / active 过渡、激活指示条；无滚动炫技、无无限循环动画。
5. **可访问性**：按钮 / 表单 / 焦点环均达 WCAG AA（主按钮白字对比 5.2:1，暗色模式 7.5:1）；
   尊重 `prefers-reduced-motion`。

## 3. Token 体系（apps/admin/src/app/globals.css）

| Token | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| `--primary` | orange-700 | orange-400 | 主按钮、强调文字 |
| `--primary-foreground` | 白 | 深色 | 主按钮文字 |
| `--accent` | orange-100 | orange-900 | hover / 激活底、图标底 |
| `--accent-foreground` | orange-700 | orange-100 | 激活文字 |
| `--ring` | orange-600 | orange-400 | 焦点环 |
| `--background` | 0.985 浅灰 | zinc-900 | 内容区 |
| `--card` / `--sidebar` | 纯白 | zinc-800 系 | 卡片 / 侧边栏 |
| `--chart-*` | 橙系梯度 + 黑 | 橙系梯度 + 白 | 图表 |
| `--radius` | 0.625rem | 同左 | 全站统一圆角 |

橙色数值与 Tailwind orange 色板一致（OKLCH），语义色保持 shadcn 默认。

**扩展规则**：

- 新增页面不要硬编码新的强调色；品牌触点一律走 `primary` / `accent` / `ring` token。
- 语义状态（成功 / 失败 / 警告）用 emerald / red / amber，不与品牌橙混淆。
- 数据性文字（数字、ID、时间、路径、配置值）用 `font-mono`；普通正文用 sans。

## 4. 字体

- Sans：Geist（`--font-geist`），正文与界面。
- Mono：Geist Mono（`--font-geist-mono`），数据 / 代码 / 路径 / 徽标。
- 中文回退：系统中文默认字体（`ui-sans-serif` 链），不额外引入中文字体文件。

## 5. 壳组件（apps/admin/src/components）

- **AppSider**：logo = 橙色提示符 `>` 方块 + 字标 + mono 副标「admin console」；
  菜单激活态 = 浅橙底 + 左侧 2px 品牌指示条（globals.css 中 `data-active::before` 实现）；
  用户区悬停弹出菜单（个人中心 / 退出）。
- **AppHeader**：左侧页面标题 + mono 路径（CLI 定位感）；右侧主题切换
  （浅色 / 深色 / 跟随系统，见 `ThemeToggle.tsx` 与 `stores/theme.store.ts`）。
- **登录页**：居中卡片 + 橙色光晕背景（呼应前台 hero，克制），品牌区用提示符方块。
- **Dashboard**：真实数据统计卡（mono 数字）+ 快速入口 + mono 系统信息面板。

## 6. 主题切换

- 存储键 `billy-admin-theme`（light / dark / system），默认跟随系统。
- `layout.tsx` 内联引导脚本在水合前设置 `.dark`，避免深色模式刷新闪烁（FOUC）。
- 系统偏好变化时，system 模式自动跟随；手动选择后以手动为准。

## 7. 新增页面自查清单

- [ ] 用 `PageToolbar` + `DataTable` / `DataList` + `ModalForm` 等既有组件，不造新容器
- [ ] 强调色只用 `primary` / `accent` / `ring` token，不硬编码颜色类
- [ ] 数字 / ID / 时间 / 路径用 `font-mono`（自动 tabular-nums）
- [ ] 浅色与深色模式都过一遍（`ThemeToggle` 切换验证）
- [ ] 主按钮 / 表单 / 焦点环对比度达 AA
