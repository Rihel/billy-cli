# 前端设计系统（@repo/ui）

> web 与 admin 共用的视觉规范（token / 主题 / 字体回退链 / 组件质感）统一归属 `@repo/ui`，
> 与其组件库同包。本文记录它的构成、守卫、取舍依据，以及落地过程中的实测结论与已知缺口。
>
> **token 的真相就是 `packages/ui/src/globals.css` 里的 CSS 变量本身** —— 没有 JS 副本、
> 没有额外抽象层（理由见 §4.2）。

## 1. 现状与缺口（2026-09-17 实测）

底子并不差 —— 语义 token、shadcn 组件库、admin 主题切换链路都已具备。缺口集中在
**「归属」与「守卫」**，而不是「token 种类不够」：

| # | 事实 | 证据 |
| --- | --- | --- |
| 1 | 品牌色有**三份互不一致**的定义 | `packages/ui/src/globals.css` 是「近黑 `--primary` + 靛紫 `--ring`」；`apps/admin/src/app/globals.css` 又叠一层组件覆盖；`apps/web` 整体绕过 token，`zinc-*` / `indigo-*` 等硬编码 **465 处 / 33 个文件** |
| 2 | 设计语言文档**已失真** | `admin-design-language.md` 写「Azure 蓝主按钮」，代码实际是近黑按钮 + 靛紫焦点环 |
| 3 | 字体接线**重复三处** | 两个 `layout.tsx` 各 `next/font` 加载 3 个字体，两份 `globals.css` 各写一遍回退链 |
| 4 | 语义色**无 token** | 只有 `--destructive`；success / warning / info 全靠 `emerald-*` / `amber-*` / `indigo-*` 现写 |
| 5 | web **无暗色能力** | `apps/web/src` 中 `dark:` 类 **0 个**，无主题切换（admin 有完整链路） |
| 6 | **无守卫防漂移** | `check:ui` 只管「组件导出完整性」+「typecheck 脚本」，硬编码颜色没人拦 |
| 7 | client 脚手架模板**无人守** | `check:scaffold` 只覆盖 service / crud 模板（其注释明写「@repo/ui 属前端，不在本脚本范围」） |
| 8 | `tag.tsx` 残留 **antd 色名** | 预设色里有 `gold` / `volcano` / `geekblue` / `magenta` / `processing` / `cyan`，且 `gold` / `cyan` 正被页面使用 |

**主要矛盾**：token 不缺，缺的是**唯一归属**与**防止漂移的机制**。故本轮不追求「token 种类齐全」，
而是把归属与守卫做扎实。

## 2. 目标与边界

### 本轮做

1. `@repo/ui` 成为 token / 主题 / 字体回退链 / 组件质感的**唯一真相**（此前名义上在 ui、实际三分天下）。
2. 两个 app 的 `globals.css` 与 `layout.tsx` 收敛为「接入 + 字面量」，删掉重复的字体回退链与局部覆盖层。
3. 补 **success / warning / info** 语义色 token（对齐既有 `--destructive` 模式，明暗各一套）。
4. admin 的「组件质感规则」上移共享 —— **web 同时获得**（细滚动条 / 等宽数字对齐）。
5. 守卫（见 §6）：token 体系用纯 CSS 自洽断言，另加三条 `check:ui` 不变量。
6. 同步 CLI 脚手架模板，让新生成的前端开箱即用同一设计系统。

### 本轮不做（逐条给依据）

| 不做 | 依据 |
| --- | --- |
| **不迁移 `apps/web` 的 465 处硬编码** | 属存量清理，改动面大、纯视觉回归风险高；用户已明确本轮不选该档。守卫改为「冻结存量、禁止新增」，为后续独立一轮铺路 |
| **不给 token 做 JS 副本**（无 `tokens.ts` / `fonts.ts`） | 实测消费者为零、且那份手抄清单本身是漂移源 —— 详见 §4.2 |
| **不加间距 / 动效 / 层级 token** | 实测 Tailwind 4.3.3 主题命名空间：**没有** `--duration-*` 与 z-index 命名空间（动效需 `@utility` 自定义）；而 `--shadow-*` 虽有命名空间，覆盖它会直接改动既有 shadcn 组件视觉。当前两端**没有**动效 / 层级不一致的证据 —— 无依据的抽象不做（够用就好） |
| **不改 `tag.tsx` 的 antd 装饰色名** | 属「去 antd 指纹」独立议题（`gold` / `cyan` 正被页面使用，需连带改调用方），与本轮「token 归属」不同源，记入 §9 |
| **不做展示页 / Storybook** | `docs/design/frontend-foundation.md` §7 已裁定不做（无自动化保障其与 token 同步，维护成本高于收益） |
| **不做 web 暗色切换** | 需要 web 全部样式先收敛到 token（即「不迁移」的前置），非本轮可完成的因果链 |

## 3. 位置

设计系统与组件库**同属 `@repo/ui`**（不新开包）：两者演进节奏一致（一次改动同时动 token 与组件），
消费方式相同（app 装同一个依赖），且**共用同一条 Turbopack 解析链路**（见 §7.2）。

```
@repo/ui       组件库（src/components/**）+ 设计系统（src/globals.css）
     ↓
apps/web | apps/admin   应用：globals.css 接入 + 字体字面量 + 页面
```

| 能力 | 位置 |
| --- | --- |
| 颜色 / 圆角 token、`@theme` 映射、base 层、`@custom-variant dark` | `packages/ui/src/globals.css` |
| 字体变量规范（回退链引用的变量名） | 同上（`@theme inline` 与 `:root` 里的 `--font-*`） |
| 组件质感规则（等宽数字 / 滚动条）、markdown 渲染与高亮 token | 同上（`@layer` 之外的规则） |
| 字体加载（`next/font`） | `apps/<app>/src/app/layout.tsx`（框架要求字面量，见 §7.1） |
| app 专属样式（前台 keyframes 等） | `apps/<app>/src/app/globals.css` |

## 4. 设计系统构成

### 4.1 token 清单（55 个 CSS 变量，明暗各一套）

| 分组 | 数量 | 说明 |
| --- | --- | --- |
| 颜色语义 token | 42 | `background` / `foreground` / `card` / `popover` / `primary` / `secondary` / `muted` / `accent` / `destructive` / **`success`** / **`warning`** / **`info`**（各含 `-foreground`）/ **`brand`** / `border` / `input` / `ring` / **`surface-1..4`**（2026-10-22 新增）/ `chart-1..5` / `sidebar-*` |
| markdown 高亮 | 11 | `--md-hl-*`（hljs token 色，CSS 规则直接消费，不生成工具类） |
| 圆角 | 1 | `--radius`（派生 `rounded-sm…4xl` 整套尺度） |
| 字体 | 1 | `--font-display` 回退链（`--font-sans` / `--font-mono` 在 `@theme` 内联） |

> 2026-11-13 核对：`packages/ui/src/globals.css` 的 `:root` 共 55 个变量（`.dark` 53 个，缺 `--radius`
> 与 `--font-display` 这两个根层专属项）。此前写的「51 个 / 颜色 38 个」是 10-22 新增
> `--surface-1..4` 之前的数，已过期。
>
> 字体实际是三个：**Geist**（`--font-sans`）/ **Geist Mono**（`--font-mono`）/
> **Space Grotesk**（`--font-display` → `--font-heading`），由两个 app 的根 `layout.tsx`
> 用 `next/font` 注入 `--font-geist` / `--font-geist-mono` / `--font-space-grotesk`。

新增的三个语义色取值与依据：

| Token | 浅色 | 深色 | 依据 |
| --- | --- | --- | --- |
| `--success` | emerald-700 `oklch(0.508 0.118 165.612)` | emerald-400 `oklch(0.765 0.177 163.223)` | 语义色会作**文字色**，浅色取 700 档才达 WCAG AA（600 档约 3.8:1，不达标） |
| `--warning` | amber-700 `oklch(0.555 0.163 48.998)` | amber-400 `oklch(0.828 0.189 84.429)` | 同上 |
| `--info` | sky-700 `oklch(0.5 0.134 242.749)` | sky-400 `oklch(0.746 0.16 232.661)` | 与品牌靛紫 `--ring` 明确区分 |

> 取值与既有 `--destructive`（浅色 red-600 / 深色 red-400）保持同一档位模式；
> 700 档的选择由 `admin-design-language.md` §2.5 的可访问性原则驱动。

### 4.2 token 分两层，改上层即全局联动

这就是 antd「**seed → map token**」在 CSS 架构下的对应物 —— 不需要把值搬进 JS 也能做到
「改一处、全套跟随」：

| 层 | 包含 | 形态 |
| --- | --- | --- |
| ① 原始层 | `background` / `card` / `foreground` / `primary` / `secondary` / `accent` / `border` / `ring` / 四个语义色 / `surface-1..4` / `radius` | 字面量（真正独立的决策） |
| ② 派生层 | `card-foreground` / `popover` / 各 `*-foreground` / `input` / `chart-1..5` / **整套 `sidebar-*`** | `var(--某个原始 token)` 引用 |

例：`--sidebar-primary: var(--primary)`、`--sidebar-ring: var(--ring)`、`--chart-1: var(--ring)`、`--popover: var(--card)`。
于是**换品牌色只需改 `--ring`（品牌点缀）与 `--primary`（主按钮）**，侧边栏、图表、强调面、
各处前景自动跟随。

- **改造前**：`50` 个 token 里 `34` 个是别的 token 的**完全复制值**（`.dark` 里 `37/48`）——
  改 `--primary` 时 `--sidebar-primary` 纹丝不动，只能靠人记着同步（shadcn 默认主题就是这个形态，
  本项目此前照抄了它的毛病）。
- **改造后**：派生关系显式化，并由守卫锁住 ——
  `packages/ui/test/tokens.test.ts` 断言「侧边栏 8 个 token 与 `chart-1` 必须是 `var()` 引用」，
  改回手抄字面量即红灯（实测）。
- **零视觉变化**：76 个快照 token 递归解析 `var()` 链后的最终值，与改造前的字面量**逐一相同**（实测）。

> 为什么 md 高亮的 `--md-hl-*` 保持字面量：那是照搬既有语法主题的配色表，
> 其中的同值（如 `keyword` 与 `deletion` 同为红）是"碰巧"而非"约定"，派生反而会误导。

### 4.3 为什么不给 token 做 JS 副本

**token 的真相就是 `globals.css` 里的 CSS 变量本身** —— 它们是具体值
（`--primary: oklch(0.205 0 0)`），且是**运行时可用**的：

- Tailwind 4 用它生成工具类（`bg-primary` / `text-muted-foreground`），这是页面里 99% 的用法；
- 内联 style / SVG 里可直接写 `var(--primary)`（shadcn chart 就是这么做的，随明暗自动切换）；
- 真要在 JS 里取值，浏览器有 `getComputedStyle(el).getPropertyValue('--primary')`。

**曾短暂加过 `tokens.ts`（token 名清单 + `colorVar()`）与 `fonts.ts`，两者均已删除** ——
实测 `tokens.ts` 的消费者只有 `src/index.ts` 的导出与它自己的测试，**组件与两个 app 零使用**：
它就是"为设计系统完整性而造"的抽象，而那份手抄的 37 个 token 名字数组本身就是新的漂移源。
`fonts.ts` 的唯一消费者是守卫本身（守卫需要的"期望值"改为直接从 `globals.css` 推导，见 §6）。

**若将来真需要 JS 侧的具体色值**（canvas 绘制、JS 动画、邮件模板、构建期生成图片），
按代价从低到高有三条路，**当前一条都不需要**：

| 做法 | 代价 |
| --- | --- |
| 内联 style / SVG 直接写 `var(--primary)` | 零冗余，随明暗自动切换 |
| 运行时读 `getComputedStyle` | 零冗余；限浏览器环境、需元素已挂载 |
| 值只定义一处（TS / JSON），构建期生成 CSS | 单一真相但要引入构建步骤（Style Dictionary 模式）；本项目无此需求 |

### 4.4 app 接入（两个 app 的 `globals.css` 结构一致）

```css
@import "tailwindcss";
@import "@repo/ui/globals.css";
@import "tw-animate-css";
@import "shadcn/tailwind.css";

@source "../../../../packages/ui/src/**/*.{ts,tsx}";   /* 组件库不经 Tailwind 构建，需扫描其类名 */

/* 以下是该 app 专属规则（如 web 的首页 keyframes），跨端共享的一律上移 ui 包 */
```

### 4.5 滚动条规范（macOS 覆盖式，两端共用）

位置：`packages/ui/src/globals.css` 的「滚动条」段（`@layer` 之外，压过 utilities）+
`packages/ui/src/components/overlay-scrollbar.tsx`。

- **为什么自己画**：原生滚动条伪元素（`::-webkit-scrollbar-thumb`）**不支持 `transition`、
  也不支持 `animation`**（2026-11-13 无头 Chrome 实测），改颜色只能硬切，做不到淡入淡出。
- **分工**：原生滚动条只保留**交互**（8px 沟槽、拖拽 / 点轨道 / 键盘），滑块涂透明；
  视觉是两个 `position: fixed` 的 4px 圆角 div（`OverlayScrollbar`），`opacity` 过渡 260ms、
  停手 700ms 淡出，`pointer-events: none` 所以拖拽仍落在下面的原生滚动条上。
- **只跟随被滚动的容器**：一条 `scroll` 捕获监听（scroll 不冒泡但走捕获阶段）记录最近滚动的
  元素，只画它的滑块——不会"滚一个区域、整页滚动条都亮"。跳过 `[data-autoscrolling]`
  （消息流自动跟随）与 `scrollbar-width: none`（`no-scrollbar` / `scrollbar-none`）。
- **几何**：`thumbBox()` 纯函数（长度 = `max(24, client/scroll × 轨道)`，偏移按滚动比例夹住）；
  文档滚动条用 `documentElement` 单独度量。两个 app 各挂一次 `OverlayScrollbar`（渲染两个 div）。
- **为什么不用标准属性**：Chromium 一旦读到容器上的 `scrollbar-width` / `scrollbar-color`，
  就会**整体忽略** `::-webkit-scrollbar` 定制、退回系统原生滚动条。所以 `scrollbar-thin`
  这类类名**不要用在容器上**；标准属性只在 `@supports not selector(::-webkit-scrollbar)`
  （Firefox）里把原生滚动条涂透明，视觉同样交给覆盖层。
- 边界：仍占 8px 布局宽度（不是真正"浮在内容上"的覆盖式）；只支持纵向/横向两个方向的
  最近滚动容器；JS 不可用时没有可见滚动条（应用本身也依赖 JS）。

## 5. 迁移步骤（已落地）

1. `packages/ui/src/globals.css` 承接 token / base 层 / `@custom-variant dark` / 组件质感规则
   （设计系统**只有这一个位置**）。
2. 两个 app 的 `globals.css` 删掉重复的字体回退链与 `@custom-variant dark`（已上移）。
3. admin 覆盖层里**真正生效**的规则（等宽数字 / 滚动条）上移 ui 包，两端共用；
   死规则不迁移（见 §8.2 ①）。
4. 两个 `layout.tsx` 的字体接线按 §7.1 的实测结论落地（字面量 + 守卫）。
5. ~~同步 `scripts/cli/templates/files/client/{globals-css,layout}.eta`。~~（模板已随 CLI 代码生成器于 2026-11-09 移除）
6. 加守卫（§6）、补文档、同步 skill。

**回滚成本**：全部改动等价搬迁，`git revert` 单个提交即可；不涉及数据与接口。

## 6. 守卫（均实测有牙齿）

| 守卫 | 拦截什么 | 反向验证 |
| --- | --- | --- |
| `packages/ui/test/tokens.test.ts`（6 项，**纯 CSS 自洽、零手工清单**） | ① 明暗不对称（浅色与深色的键集合必须完全一致）② `@theme` 映射不自洽（`--color-X: var(--Y)` 指向别的变量 → 工具类取值落空）③ 映射来源变量缺定义 ④ 颜色 token 漏映射 ⑤ 根层专属 token 缺失 ⑥ 字体回退链未引用 app 注入的变量 | 删深色 `--success`（2 项红）/ 摘 `@theme` 映射 / 把映射指向不存在的变量 / 新增 token 只写浅色 → **各自红灯** |
| `pnpm check:ui` ③ 禁止新增硬编码调色板 | 在 `packages/ui/src` 与 `apps/<app>/src` **新增**调色板类（`bg-blue-500` 等） | 基线按「文件 → 上限」冻结，超限即违例；只许减少不许增加。**2026-11-13 实测**全仓命中 7 文件 / 7 处：`apps/web` 6 处 `to-violet-600` + `packages/ui/src/components/display.tsx` 1 处；基线表里仍留有一些历史条目（旧 admin 路径、`tag.tsx` 30），是未回收的松量 |
| `pnpm check:ui` ④ 样式入口可解析 | `apps/*/src` 与 `packages/ui/src` 里 `@import "@repo/x/y.css"` 指向不存在的文件 | 包改名 / 导出改名后引用静默失效（实测抓到过 IDE 入口 `tailwind-ide.css` 的残留引用） |
| `pnpm check:ui` ⑤ 字体规范一致 | `apps/<app>/src/app/layout.tsx` 的 `next/font` 变量名与 `globals.css` 字体回退链不一致（规范**从 CSS 推导**，不维护第二份清单） | 改一个字体字面量即违例 |
| `pnpm check:ui` ①②（既有） | 自有组件未导出 / 前端包缺 `typecheck` 脚本 | — |

> `tokens.test.ts` 顶部有 `// @vitest-environment node`：ui 包默认是 jsdom 环境，
> 而 `import.meta.url` 在 jsdom 下不是 `file://`，`fileURLToPath` 会抛
> `The URL must be of scheme file`（实测踩过）。纯文本解析类测试都该标 node 环境。

## 7. 关键实测结论

### 7.1 `next/font` 拒绝任何非字面量

把变量名常量（哪怕来自 `@repo/ui`）传给 `variable` 会直接构建失败：

```
Error: Font loader values must be explicitly written literals.
  variable: fontVariables.mono,
```

这是框架机制（加载器需要编译期静态可解析的值），**与包边界无关** —— 即便把 `next/font`
调用搬进组件库同样过不去。故字体接线最终形态是「**字面量 + 守卫**」：
app 写死字面量，数据结构放在 `globals.css` 的回退链里，`check:ui` 第 ⑤ 条保证两侧一致
（守卫从 CSS 推导期望值，避免多出一份清单）。
历史参考：[vercel/next.js#51476](https://github.com/vercel/next.js/issues/51476)。

### 7.2 独立成包会让 Turbopack dev 解析不到 CSS 入口（已回退）

**现象**：把设计系统拆成新包 `@repo/design` 后，`next build` 通过，但两个 app 的
**dev 全部 500**：

```
CssSyntaxError: tailwindcss: apps/web/src/app/globals.css:1:1:
Can't resolve '@repo/design/globals.css' in '.../apps/web/src/app'
```

产物 CSS 是 138 字节的 `/* unparsable ... */` 空壳（正常应为 250+ KB）。

**根因**：两个 app 的 `next.config.ts` 里有 `transpilePackages: ['@repo/ui']` ——
Turbopack dev 只对**该列表内的 workspace 包**做完整解析（含其 CSS 入口）；
新包不在列表里，`@import "@repo/design/globals.css"` 就解析不到。
`next build` 的解析路径更宽松，所以「构建绿、开发红」。
（清 `.next` 缓存无效，排除了缓存假设；连从 app 目录手动 `postcss` 编译都能成功，
说明是 Turbopack 的包解析约束，不是文件系统问题。）

**处置**：设计系统合并进 `@repo/ui`（既有包、已在 `transpilePackages` 内），
dev 立即恢复（HTTP 200，CSS 产物回到 279 KB）。

**教训（新增前端 workspace 包时必查）**：
1. 新包不仅要加依赖，还要**同步 `apps/*/next.config.ts` 的 `transpilePackages`**；
2. **`next build` 通过不等于 dev 可用** —— 涉及包解析 / CSS 入口的改动，必须真跑一次 dev 验证。

### 7.3 `@source` 留在 app，不收口到包内

Tailwind 4 多包场景的通行做法是在应用入口声明 `@source` 指向组件库源码（app 侧一行），
ui 包不参与类名扫描的声明（它自己不经 Tailwind 构建）。

## 8. 落地记录与实测（2026-09-17）

### 8.1 实际位置

| 项 | 文件 |
| --- | --- |
| 设计系统 | `packages/ui/src/globals.css`（**唯一定义处**：token / `@theme` / base / 质感规则） |
| 守卫 | `packages/ui/test/tokens.test.ts`（当时 5 项；2026-11-13 为 6 项）、`scripts/check-ui.ts`（新增 ③④⑤ 三条不变量） |
| 接入方 | `apps/{web,admin}/src/app/{globals.css,layout.tsx}`（app 只留接入 + 字面量 + 专属规则） |
| 组件消费者 | `packages/ui/src/components/tag.tsx` 的语义四色改走 token（`success` / `error` / `warning` / `processing`），antd 装饰色名保留待后续 |
| 脚手架模板 | ~~`scripts/cli/templates/files/client/{globals-css,layout}.eta`~~（2026-11-09 随 CLI 代码生成器移除） |
| 文档 | 新增本文；`admin-design-language.md` 重写为「应用层」并修正失真；`README.md`、`commands.md`、`develop-frontend-page` skill 同步 |

### 8.2 落地过程中修掉的真问题（方案阶段未预见，靠实测暴露）

1. **admin 的「主按钮质感」规则从未生效**（双重失效）：选择器写的是
   `[data-slot="button"][data-variant="primary"]`，但按钮 variant 名是 **`default`**，
   且 `Button` 只渲染 `data-slot` 而**没有** `data-variant` 属性 —— 这条规则自写入起就是死代码。
   故本轮**不迁移**它（迁移死规则会让 web 一起继承无效样式），改为记入 §9。
2. **`next/font` 要求字面量** → 字体规范改为「字面量 + 守卫」（§7.1）。
3. **独立成包导致 dev 全挂** → 回退合并进 `@repo/ui`（§7.2）。
4. **`tokens.ts` / `fonts.ts` 是零消费者的抽象** → 删除，守卫改为从 CSS 推导（§4.2、§6）。
5. **守卫有漏洞**：`--color-input: var(--input-typo)`（映射指向不存在的变量）曾能通过测试 ——
   只校验了「键存在」没校验「映射来源」。已补断言（键值必须同名 + 来源必须明暗都有定义）。
6. **ui 包 jsdom 环境下 `fileURLToPath` 抛错** → 测试标注 `// @vitest-environment node`（§6 注）。
7. **`check:scaffold` 不覆盖 client 模板**（其注释明写前端不在范围）→ 新增 `check:ui` 第 ④ 条兜底；
   该条后来扩到 app / ui 自身 CSS，**立刻抓到**了 `tailwind-ide.css` 里残留的已删除包引用。
8. **`admin-design-language.md` 的品牌色描述与代码不符**（写 Azure 蓝，实际近黑 + 靛紫）→ 已修正。
9. **token 是平铺的手抄表、不是分层结构**（改一处不联动）→ 重构为「原始层 + 派生层」，
   派生关系显式化并用守卫锁住（§4.2）；实测零视觉变化。

### 8.3 实测结果

| 验证 | 结果 |
| --- | --- |
| `pnpm typecheck` | 3/3 通过（web / admin / ui） |
| `pnpm test` | 6 包全绿；`packages/ui` 32 项（含设计系统守卫 6 项 + tag 5 项） |
| token 分层重构 | 76 个快照 token 解析 `var()` 链后与改造前字面量**逐一相同**（零视觉变化）；改 `--primary` → `sidebar-primary` / `accent-foreground` / `secondary-foreground` 全部跟随（联动生效） |
| 守卫反向验证 | 删深色 token（2 项红）/ 摘 `@theme` 映射 / 映射指向不存在的变量 / 新增 token 只写浅色 / 改字体字面量 → **全部红灯**，恢复即绿 |
| `pnpm check:ui` | ✅ 五条不变量全过（当日为 465 处存量基线；现基线见 §6） |
| `pnpm check:scaffold` | ✅ 导入名 + service / crud 模板类型检查通过（脚本已于 2026-11-09 移除） |
| 生产构建 | `apps/admin` ✅（12 路由）、`apps/web` ✅（14 路由） |
| **dev（关键）** | `apps/web` 9840 / `apps/admin` 9845 均 **HTTP 200**，CSS 产物 279 KB / 259 KB（修复前为 138 字节空壳） |

## 9. 已知缺口（记在案，本轮不修）

1. ~~**`apps/web` 465 处硬编码调色板类**（33 个文件，落地页为主）：收敛到语义 token 后
   web 才能获得暗色能力。守卫已冻结存量、禁止新增，可作为独立一轮推进。~~
   **→ 已于 2026-09-18 完成，见 §10。**
2. **`tag.tsx` 的 antd 装饰色名**（`gold` / `volcano` / `geekblue` / `magenta` / `cyan` /
   `processing`）：属「去 antd 指纹」，需连带改调用方。
3. **admin 主按钮质感规则缺失**（原规则从未生效，见 §8.2 ①）：待决定「按 `variant="default"`
   修好并两端共享」还是「永久删除」—— 属视觉决策，未擅自替用户决定。
4. **非颜色 token（间距 / 动效 / 层级）**：依据见 §2，等出现真实不一致证据再加。
5. **调色板基线的松量未回收**（2026-11-13 核对）：`scripts/check-ui.ts` 的 `PALETTE_BASELINE` 里仍留着
   旧 admin 路由路径（`apps/admin/src/app/auth/...`、`apps/admin/src/app/main/...`，路由组改造后已不匹配任何文件）
   与 `tag.tsx: 30` 等历史上限；实际命中是 7 文件 / 7 处。基线只会拦「超限」，不会拦「上限虚高」，
   属于守卫的已知松量，待下一轮清理。

## 10. 2026-09-18 更新：`--brand` token + web 全量收敛 + 主题能力上移

§1 / §9 记的「web 绕过 token、465 处硬编码」已解决；本节是落地记录与新增依据。

### 10.1 新增 `--brand`（当时第 38 个颜色 token；现共 42 个）

落地页用的强调色（图标底 / 徽标 / 渐变起点 / 发光 / 分节线）原本是硬编码 `indigo-*`，而
`--primary` 是**刻意近黑**（避开 antd 蓝实心按钮指纹）、`--ring` 只叫「焦点环」—— 拿它当文字色
命名上讲不通。故把**已有取值**升格为独立 token：

| 位置 | 浅色 | 深色 |
| --- | --- | --- |
| `--brand`（2026-09-18 加入时） | `oklch(0.585 0.233 277.117)`（= 原 `--ring`） | `oklch(0.673 0.182 276.935)`（= 原深色 `--ring`） |
| `--brand`（2026-11-13 现值） | `oklch(0.55 0.21 280)` | `oklch(0.673 0.182 277)` |
| `--ring` | `var(--brand)`（派生） | 同 |
| `--chart-1` | `var(--brand)` | 同 |

> 现值由 2026-10-22「品牌色回到界面主体」一轮调整（§11）；上表保留加入时的取值，便于追溯。

**浅色零视觉变化**（取值就是原来的 `--ring`），深色下 brand 作文字色取 400 档满足对比度 ——
与既有 `--destructive` / `--success` 的档位模式一致。新增 token 后 `tokens.test.ts` 六项守卫全绿
（明暗对称 / `@theme` 映射 / 派生层不抄字面量）。

### 10.2 `apps/web` 全量收敛

- **411 处替换**（25 个文件）：`zinc-*` → `foreground` / `muted-foreground` / `muted` / `border` /
  `card` / `background`；`bg-zinc-950 text-white`（近黑主 CTA）→ `bg-primary text-primary-foreground`；
  `emerald` / `red` / `amber` → `success` / `destructive` / `warning`；`indigo-*` → `brand`（带透明度
  的形态走 `bg-brand/10` 这类 alpha，而不是再养一套 subtle token）。
- **守卫漏网的白/黑也清了**：`bg-white`(21) / `text-white`(10) 不在 `check:ui` 的调色板正则里
  （该正则只认 `-<色阶数字>`），但它们是暗色真正的拦路虎 —— 一并处理：页面级 → `bg-background`、
  卡片/面板 → `bg-card`、吸顶栏 → `bg-background/80`、渐变徽标上的 `text-white` **保留**
  （白字配饱和渐变在明暗两态都成立）。
- **有意保留的 1 个例外**：品牌渐变终点 `to-violet-600`（6 处）—— violet 无对应 token，
  且该渐变在两种底色上都成立；基线按文件锁 1 处，想归零就先加「品牌次色」token。
- 基线从「33 文件 / 465 处」收紧到「6 文件 / 各 1 处」，并**反向验证过有牙齿**：
  往 `hero.tsx` 塞回一个 `bg-indigo-500` 立刻退出码 1。

### 10.3 主题能力上移 `@repo/ui`

此前主题（三态 `light/dark/system` + 持久化 + `.dark` 切换 + 系统偏好监听 + 防闪烁脚本）只在
`apps/admin`，前台拿不到暗色。现位置：

| 内容 | 位置 | 说明 |
| --- | --- | --- |
| 纯逻辑 + 防闪烁脚本 | `packages/ui/src/lib/theme.ts` | `resolveDark` / `applyThemeClass` / `readStoredMode` / `writeStoredMode` / `createThemeBootScript`；**不带 `'use client'`**，服务端 layout 可直接调用 |
| React 侧 | `packages/ui/src/components/theme.tsx` | `createTheme({ storageKey })` → `{ useTheme, initTheme }`（模块闭包 + `useSyncExternalStore`，**不引入 zustand**）+ 受控组件 `ThemeToggle` |
| app 侧 | `apps/{web,admin}/src/stores/theme.ts` | 各 6 行：只给**本应用的存储 key** |

**为什么 key 必须参数化**：同域部署时 `localStorage` 共享，写死一个 key 会让后台切深色把前台也改掉
（与 `TokenKey` 必须两端不同同一个道理）。测试里专门有一条「两个 app 不同 key 互不干扰」。

落地页头部与移动端抽屉各挂了一个主题入口；`apps/admin` 行为不变（key 仍是 `billy-admin-theme`，
防闪烁脚本改由 `createThemeBootScript` 生成，不再手抄字面量）。

### 10.4 本轮验证

`typecheck`（8 包）/ `test`（7 包；ui 52 项含新增主题 13 项）/ `check:ui` / `check:scaffold` 全绿
（`check:scaffold` 已于 2026-11-09 随 CLI 代码生成器移除，此为当日记录）；
运行中 dev：web 首页 200（236 KB，CSS 291 KB）、`bg-brand`/`text-brand`/`bg-muted`/`bg-card` 等
新工具类**确实进了产物 CSS**、`.dark` 块存在、防闪烁脚本带 `billy-theme`；admin 登录页 200 且脚本为
`billy-admin-theme`；web `/nope` 404、`/auth/login` 200。

**已知残留**：暗色是「结构性可用」（token / 切换 / 脚本 / 产物类名都已验证），
但**没有做逐页视觉回归** —— 落地页在深色下的实际观感建议人工过一眼（尤其渐变发光与阴影部分）。

## 11. 2026-10-22 更新：中性底注入色相，品牌色回到界面主体

### 11.1 问题：去掉一切颜色之后，界面变成「一片灰白」

上一轮（10-21）为了去 antd 指纹，把卡片 / 侧栏 / 表格统一成同一套中性面层，并去掉了边框与
装饰色。结果是：页面底、卡片、侧栏的明度差只有 1.3%，所有强调色都退到图标与焦点环，
**整屏是零彩度的白与灰** —— 数据密度再高也读不出层次，人看着发闷。

### 11.2 改法：中性色带一丝冷调 + 拉开面层 + 品牌色承担强调

| 项 | 改前 | 改后 |
| --- | --- | --- |
| `--background`（浅） | `oklch(0.985 0 0)` 近白 | `oklch(0.962 0.006 265)` 冷调浅灰（页面底） |
| `--surface-1..4`（浅） | 0.975 / 0.962 / 0.948 / 0.932，零彩度 | 0.988 / 0.972 / 0.952 / 0.928，chroma 0.004~0.008 |
| `--card` | 纯白 | 纯白（卡片比页面底亮，自带抬升） |
| `--muted-foreground` | `0.556 0 0` | `0.5 0.014 265`（对比度提一档） |
| `--sidebar` | `var(--card)`（与卡片同色） | `var(--surface-3)`（比内容区沉一档的导轨） |
| `--sidebar-accent` / `-foreground` | 中性 `--accent` | `color-mix(in oklab, var(--brand) 10%, transparent)` + `var(--brand)` |
| `--chart-1..5` | 灰 + 三档蓝 | 品牌靛紫 → 青 → 琥珀 → 品红 → 石板灰 |
| `--brand` 用途 | 只做焦点环与图表首色 | 侧栏激活态、品牌标记、图标色片、图表主色 |

**为什么给中性色加 chroma 而不是继续用 0**：0 彩度的灰在多数屏幕上显得发闷、发脏（尤其
大面积浅灰）；0.004~0.008 的冷调肉眼几乎看不出「有色」，但白不再惨白、灰不再像起雾。
深色侧同样处理（`0.16 0.008 265` 起）。

**为什么保留「无边框 + 面层明度」这条主线**：边框会把界面切碎，层次应该只由面层差表达；
本轮只是把明度差从 1.3% 拉到 2%~3%，并让卡片（`--card` 纯白）浮在页面底（0.962）之上。
**不叠加投影、不补描边** —— 一旦用阴影兜底，面层阶梯就退化成装饰，暗色下也会发灰。

### 11.3 组件的连带调整

- **Card**：`bg-surface-1` → `bg-card`（纯白对页面底就是一阶微色阶），不加投影、不加 ring。
- **DataTable**：容器改为 `rounded-xl bg-card`（无边框、无投影）；表头 `bg-surface-2/60`；
  行改为**只保留 hover**（去掉 `even:bg-surface-1` 的斑马纹 —— 白卡上的交替灰条是噪点）。
- **TableRow**：hover 走 `bg-surface-2/70`。
- **Acrylic 页头**（admin `AppHeader`）：`bg-background/85 + backdrop-blur-sm`，与内容区连续。
- **token 守卫**：`tokens.test.ts` 的「派生层不许抄字面量」允许基于 `var()` 的 `color-mix`
  表达式（品牌淡底必须由 `--brand` 派生）；`chart-1` / `sidebar-primary` 的目标值改为 `var(--brand)`。

### 11.4 页面落地（admin）

- **控制台**：统计块改「彩色图标色片 + 标签 + 大数字」；浅色下整块平涂 6%~7% 品牌/语义色
  （深色下退回中性面，避免暗底上的彩色块发浑）；服务状态改语义色胶囊；AI 用量柱状与环图走 `--chart-*`。
- **监控状态**：拖拽卡片由灰色面层改为白卡；水位图改用半透明平涂 + 细环；图表 Y 轴留白修正
  （`margin.left: -18` 会把刻度数字切掉）。
- **登录页**：品牌标记改 `bg-brand`、表单卡改白面上浮；左栏保持纯面色，不做装饰渐变。
- **列表页**：随 `DataTable` 一起变成「灰底 + 白卡表」，斑马纹去掉。

### 11.5 不用渐变、不用边框

界面一律**不使用渐变**（背景色晕、卡片晕染、图表面积填充都算）：大面积渐变在浅底上容易显脏、
在深底上容易发浑。层次靠面层明度差，强调靠品牌色 / 语义色的平涂与小面积色片。

层次结构**只用微色阶表达**（页面底 0.962 → 卡片 1.0 → 卡内磁贴 0.972 → 更深一档 0.952），
**不用结构边框，也不拿投影兜底**：卡片、表格容器、统计块、水位图外圈、登录页悬浮卡都不带
ring / border / shadow。表单控件保留自身描边（输入框的边界是可用性，不是装饰）。
面积图用 `fillOpacity` 平涂；水位图用同色半透明填充；登录页左栏不做光晕。

### 11.6 内容主次

**页面呈现的内容本身有主次** —— 先定「这一页为什么存在」，主内容占最大面积与最靠上的位置，
次内容支撑判断，辅助内容收成一行小字。字号与颜色只是表达手段，不是主次本身。

| 层级 | 是什么 | 布局表达 | 文字表达 |
| --- | --- | --- | --- |
| 主内容 | 页面存在的理由：用户第一时间要得到的结论或要操作的对象 | 占满宽度 / 最靠上 / 面积最大 | 前景色 + `font-medium`，数字 `tabular-nums`，状态色只给结论 |
| 次内容 | 支撑判断的上下文：趋势、分布、明细列表 | 主内容之下，两列或分栏 | `text-muted-foreground` 的说明 + 正常前景的正文 |
| 辅助内容 | 元信息与规模数字：实例 ID、时间槽、总数、时间戳 | 收成一行，放页面底部或角落 | `font-mono text-[11px] text-muted-foreground` |

落地样例：

- **控制台**：主内容 = 运行状态（依赖健康 + 未恢复告警）→ 次内容 = AI 用量趋势 →
  辅助 = 用户 / 规则 / 记录数收成一行（这三个数是规模，不是判断依据）。
- **监控状态**：主内容 = 关键水位（带「堆内存越线」结论）→ 次内容 = QPS 趋势、采集异常、
  指标健康度 → 辅助 = 实例 / 时间槽 / 指标数 / 规则数沉到底部。
- **列表页**：主内容 = 表格本身与主列；次内容 = 搜索与筛选；辅助 = 分页与 ID / 时间戳。

同一行最多一个 `font-medium`。页头标题与侧栏菜单同源（`menuTitleOf` 从 `MENU_ITEMS` 推导），
避免新增页面时标题空着。

### 11.7 验证

`pnpm typecheck`（5 包）/ `pnpm check:ui` / `pnpm --filter @repo/ui test`（71 项，含 token 守卫）
通过；admin 与 monitor 页在明暗两套主题下逐页截图对比（无头 Chrome + CDP 注入登录态）。

## 12. 2026-11-13 现状快照

- **token**：`packages/ui/src/globals.css` 的 `:root` 共 **55 个变量**（颜色 42 / md 高亮 11 / 圆角 1 / 字体 1），
  明暗两套；`--brand` 现值 `oklch(0.55 0.21 280)`（深色 `oklch(0.673 0.182 277)`）。
- **字体**：Geist / Geist Mono / Space Grotesk，`next/font` 在两个 app 的根 layout 注入 `--font-geist*` /
  `--font-space-grotesk`，`globals.css` 拼 `--font-sans` / `--font-mono` / `--font-display`（`--font-heading` 派生）。
- **组件库**：`components/ui` **61** 个、`components/ai-elements` **48** 个、平铺自有组件 **35** 个、hooks **6** 个；
  `@repo/ui` 测试 **17 文件 / 118 项**（含 token 守卫 6 项）—— 文中此前的「ui 32 / 52 / 71 项」都是历史值。
- **主题**：admin 与 web 都具备三态切换（key 分别是 `billy-admin-theme` / `billy-theme`）；
  web 的 `dark:` 类为 0，说明暗色完全由 token 承担 —— 与 §10.3 的目标一致。
- **check:ui**：五条不变量全过；`tokens.test.ts` 六项全过（2026-11-13 实跑）。
