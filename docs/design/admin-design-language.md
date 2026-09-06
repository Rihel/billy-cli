# Admin 端设计语言（Billy Admin Design Language）

> 生效范围：`apps/admin`。语义 token（--primary / --ring / --chart-* / --sidebar-*）已统一上移为
> `@repo/ui` 的默认主题（`packages/ui/src/globals.css`），admin 与应用前台共享同一套品牌；
> `apps/admin/src/app/globals.css` 只保留 admin 专属的少量视觉规则（主按钮阴影 / 激活指示条 /
> 滚动条 / mono 数字对齐），不再重复定义 token。

## 1. 定位与品牌

- **产品**：Billy Cli（一套模板，全栈直达），开发者工具。
- **受众**：开发者 / 运维 / 运营人员。
- **基调**：亮色优先 devtool 风（Linear / Vercel 式克制精确），完整深色模式。
- **品牌色**：冷调亮蓝 Azure 系（blue-500/600，深色模式 blue-400），与前台 landing（`apps/web`）
  一致。单一强调色，语义色（success / destructive / warning）独立，不与品牌色混用。

## 2. 设计原则

1. **单一强调色**：Azure 蓝只做「品牌触点」（主按钮、激活态、焦点环、logo），其余一律中性灰阶。
2. **命令行精确感**：mono 字体（Geist Mono）用于 ID / 数字 / 时间戳 / 路径 / 配置值，
   配合 `tabular-nums` 对齐；logo 用 CLI 提示符 `>` 方块。
3. **表面分层**：内容区浅灰（`--background`）、卡片与侧边栏纯白（`--card` / `--sidebar`）、
   悬浮层 `--popover`；层次靠底色差 + 细边框 + 克制阴影，不做重投影。
4. **克制动效**：hover / active 过渡、激活指示条；无滚动炫技、无无限循环动画。
5. **可访问性**：按钮 / 表单 / 焦点环均达 WCAG AA（主按钮白字对比 ≥ 4.5:1，暗色模式亮蓝配深字），
   尊重 `prefers-reduced-motion`。

## 3. Token 体系（@repo/ui/src/globals.css，admin 与应用前台共享）

| Token | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| `--primary` | blue-600（约 5.2:1 白字） | blue-400 | 主按钮、强调文字 |
| `--primary-foreground` | 白 | 深色 | 主按钮文字 |
| `--accent` | blue-100 | blue-900 | hover / 激活底、图标底 |
| `--accent-foreground` | blue-800 | blue-100 | 激活文字 |
| `--ring` | blue-500 | blue-500 | 焦点环 |
| `--background` | 极浅冷灰 | 深蓝黑 | 内容区 |
| `--card` / `--sidebar` | 纯白 | 深蓝黑系 | 卡片 / 侧边栏 |
| `--chart-*` | 蓝-青-靛梯度 | 亮蓝梯度 | 图表 |

Azure 蓝色数值与 Tailwind blue/sky 色板一致（OKLCH），语义色保持 shadcn 默认。

**扩展规则**：

- 新增页面不要硬编码新的强调色；品牌触点一律走 `primary` / `accent` / `ring` token。
- 语义状态（成功 / 失败 / 警告）用 emerald / red / amber，不与品牌蓝混淆。
- 数据性文字（数字、ID、时间、路径、配置值）用 `font-mono`；普通正文用 sans。

## 4. 字体

- Sans：Geist（`--font-geist`），正文与界面。
- Mono：Geist Mono（`--font-geist-mono`），数据 / 代码 / 路径 / 徽标。
- 中文回退：系统中文默认字体（`ui-sans-serif` 链），不额外引入中文字体文件。

## 5. 壳组件（apps/admin/src/components）

- **AppSider**：logo = Azure 蓝渐变（sky-500 → blue-600）TerminalSquare 方块 + 字标 +
  mono 副标「admin console」；菜单激活态 = 浅蓝底 + 左侧 2px 品牌指示条
  （globals.css 中 `data-active::before` 实现）；用户区悬停弹出菜单（个人中心 / 退出）。
- **AppHeader**：左侧页面标题 + mono 路径（CLI 定位感）；右侧主题切换
  （浅色 / 深色 / 跟随系统，见 `ThemeToggle.tsx` 与 `stores/theme.store.ts`）。
- **登录页**：居中卡片 + Azure 蓝光晕背景（呼应前台 hero，克制），品牌区用 TerminalSquare 方块。
- **Dashboard**：真实数据统计卡（mono 数字）+ 快速入口 + 服务状态点（hover 走 primary token）。

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
