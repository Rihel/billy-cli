# 前端设计系统（@repo/ui）

> web 与 admin 共用的视觉契约（token / 主题 / 字体回退链 / 组件质感）统一归属 `@repo/ui`，
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

## 3. 落点

设计系统与组件库**同属 `@repo/ui`**（不新开包）：两者演进节奏一致（一次改动同时动 token 与组件），
消费方式相同（app 装同一个依赖），且**共用同一条 Turbopack 解析链路**（见 §7.2）。

```
@repo/ui       组件库（src/components/**）+ 设计系统（src/globals.css）
     ↓
apps/web | apps/admin   应用：globals.css 接入 + 字体字面量 + 页面
```

| 能力 | 落点 |
| --- | --- |
| 颜色 / 圆角 token、`@theme` 映射、base 层、`@custom-variant dark` | `packages/ui/src/globals.css` |
| 字体变量契约（回退链引用的变量名） | 同上（`@theme inline` 与 `:root` 里的 `--font-*`） |
| 组件质感规则（等宽数字 / 滚动条）、markdown 渲染与高亮 token | 同上（`@layer` 之外的规则） |
| 字体加载（`next/font`） | `apps/<app>/src/app/layout.tsx`（框架要求字面量，见 §7.1） |
| app 专属样式（前台 keyframes 等） | `apps/<app>/src/app/globals.css` |

## 4. 设计系统构成

### 4.1 token 清单（50 个 CSS 变量，明暗各一套）

| 分组 | 数量 | 说明 |
| --- | --- | --- |
| 颜色语义 token | 37 | `background` / `foreground` / `card` / `popover` / `primary` / `secondary` / `muted` / `accent` / `destructive` / **`success`** / **`warning`** / **`info`**（各含 `-foreground`）/ `border` / `input` / `ring` / `chart-1..5` / `sidebar-*` |
| markdown 高亮 | 11 | `--md-hl-*`（hljs token 色，CSS 规则直接消费，不生成工具类） |
| 圆角 | 1 | `--radius`（派生 `rounded-sm…4xl` 整套尺度） |
| 字体 | 1 | `--font-display` 回退链（`--font-sans` / `--font-mono` 在 `@theme` 内联） |

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
| ① 原始层 | `background` / `card` / `foreground` / `primary` / `secondary` / `accent` / `border` / `ring` / 四个语义色 / `radius` | 字面量（真正独立的决策） |
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

## 5. 迁移步骤（已落地）

1. `packages/ui/src/globals.css` 承接 token / base 层 / `@custom-variant dark` / 组件质感规则
   （设计系统**只有这一个落点**）。
2. 两个 app 的 `globals.css` 删掉重复的字体回退链与 `@custom-variant dark`（已上移）。
3. admin 覆盖层里**真正生效**的规则（等宽数字 / 滚动条）上移 ui 包，两端共用；
   死规则不迁移（见 §8.2 ①）。
4. 两个 `layout.tsx` 的字体接线按 §7.1 的实测结论落地（字面量 + 守卫）。
5. 同步 `scripts/cli/templates/files/client/{globals-css,layout}.eta`。
6. 加守卫（§6）、补文档、同步 skill。

**回滚成本**：全部改动等价搬迁，`git revert` 单个提交即可；不涉及数据与接口。

## 6. 守卫（均实测有牙齿）

| 守卫 | 拦截什么 | 反向验证 |
| --- | --- | --- |
| `packages/ui/test/tokens.test.ts`（5 项，**纯 CSS 自洽、零手工清单**） | ① 明暗不对称（浅色与深色的键集合必须完全一致）② `@theme` 映射不自洽（`--color-X: var(--Y)` 指向别的变量 → 工具类取值落空）③ 映射来源变量缺定义 ④ 颜色 token 漏映射 ⑤ 根层专属 token 缺失 ⑥ 字体回退链未引用 app 注入的变量 | 删深色 `--success`（2 项红）/ 摘 `@theme` 映射 / 把映射指向不存在的变量 / 新增 token 只写浅色 → **各自红灯** |
| `pnpm check:ui` ③ 禁止新增硬编码调色板 | 在 `packages/ui/src` 与 `apps/<app>/src` **新增**调色板类（`bg-blue-500` 等） | 基线按「文件 → 上限」冻结（33 文件 / 465 处），超限即违例；只许减少不许增加 |
| `pnpm check:ui` ④ 样式入口可解析 | `apps/*/src`、`packages/ui/src`、`scripts/cli/templates` 里 `@import "@repo/x/y.css"` 指向不存在的文件 | 包改名 / 导出改名后引用静默失效（实测抓到过 IDE 入口 `tailwind-ide.css` 的残留引用） |
| `pnpm check:ui` ⑤ 字体契约一致 | `apps/<app>/src/app/layout.tsx` 与 client 模板的 `next/font` 变量名与 `globals.css` 字体回退链不一致（契约**从 CSS 推导**，不维护第二份清单） | 改一个字体字面量即违例 |
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
app 写死字面量，契约放在 `globals.css` 的回退链里，`check:ui` 第 ⑤ 条保证两侧一致
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

### 8.1 实际落点

| 项 | 文件 |
| --- | --- |
| 设计系统 | `packages/ui/src/globals.css`（**唯一定义处**：token / `@theme` / base / 质感规则） |
| 守卫 | `packages/ui/test/tokens.test.ts`（5 项纯 CSS 自洽断言）、`scripts/check-ui.ts`（新增 ③④⑤ 三条不变量） |
| 接入方 | `apps/{web,admin}/src/app/{globals.css,layout.tsx}`（app 只留接入 + 字面量 + 专属规则） |
| 组件消费者 | `packages/ui/src/components/tag.tsx` 的语义四色改走 token（`success` / `error` / `warning` / `processing`），antd 装饰色名保留待后续 |
| 脚手架模板 | `scripts/cli/templates/files/client/{globals-css,layout}.eta` |
| 文档 | 新增本文；`admin-design-language.md` 重写为「应用层」并修正失真；`README.md`、`commands.md`、`develop-frontend-page` skill 同步 |

### 8.2 落地过程中修掉的真问题（方案阶段未预见，靠实测暴露）

1. **admin 的「主按钮质感」规则从未生效**（双重失效）：选择器写的是
   `[data-slot="button"][data-variant="primary"]`，但按钮 variant 名是 **`default`**，
   且 `Button` 只渲染 `data-slot` 而**没有** `data-variant` 属性 —— 这条规则自写入起就是死代码。
   故本轮**不迁移**它（迁移死规则会让 web 一起继承无效样式），改为记入 §9。
2. **`next/font` 要求字面量** → 字体契约改为「字面量 + 守卫」（§7.1）。
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
| `pnpm check:ui` | ✅ 五条不变量全过（465 处存量基线） |
| `pnpm check:scaffold` | ✅ 导入名 + service / crud 模板类型检查通过 |
| 生产构建 | `apps/admin` ✅（12 路由）、`apps/web` ✅（14 路由） |
| **dev（关键）** | `apps/web` 9840 / `apps/admin` 9845 均 **HTTP 200**，CSS 产物 279 KB / 259 KB（修复前为 138 字节空壳） |

## 9. 已知缺口（记在案，本轮不修）

1. **`apps/web` 465 处硬编码调色板类**（33 个文件，落地页为主）：收敛到语义 token 后
   web 才能获得暗色能力。守卫已冻结存量、禁止新增，可作为独立一轮推进。
2. **`tag.tsx` 的 antd 装饰色名**（`gold` / `volcano` / `geekblue` / `magenta` / `cyan` /
   `processing`）：属「去 antd 指纹」，需连带改调用方。
3. **admin 主按钮质感规则缺失**（原规则从未生效，见 §8.2 ①）：待决定「按 `variant="default"`
   修好并两端共享」还是「永久删除」—— 属视觉决策，未擅自替用户决定。
4. **非颜色 token（间距 / 动效 / 层级）**：依据见 §2，等出现真实不一致证据再加。
