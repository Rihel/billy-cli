# 整页：拆片段 + 构建成单文件

`SKILL.md` 只给流程，这里给细节。**整页交付一律走这套**（不按体积判断要不要拆）；
聊天里的 `html` / `gsap` 围栏是片段，没有文件可构建，用不上这份。

## 为什么必须构建

预览是沙箱 iframe 的 `srcdoc`：**只有一份文本**，没有第二份文件，也没有同源。
所以 `./style.css`、`./app.js`、`./logo.png` 这类相对路径一律落空，而且**不报错**（静默空白）。
源码可以拆成多个文件，但交付物必须是内联齐全的单文件。

## 目录约定

在会话目录的 `tmp/html/<slug>/` 下构建：

```
tmp/html/<slug>/src/index.html         骨架：<head>、Tailwind、第三方库、<!-- include: ... -->
tmp/html/<slug>/src/sections/*.html    片段：只写片段，不写 <!doctype> / <html> / <head> / <body>
tmp/html/<slug>/src/styles/app.css     可选，按需内联
tmp/html/<slug>/src/scripts/app.js     可选，按需内联
tmp/html/<slug>/scripts/build-html.mjs 构建脚本（从技能 scripts/ 原样拷来，不要自己重写）
tmp/html/<slug>/dist/index.html        产物：file-submit 提交这个
```

`src/` 与 `dist/` 留在 `tmp/html/<slug>/` 即可，用户只看到提交的那个文件（`file-submit` 的 `fileKey`）。

## 两条协议（脚本只认这两条）

1. **include**：`<!-- include: sections/hero.html -->`
   - 路径相对**当前文件**所在目录，可递归；
   - 深度 ≤ 8，片段总数 ≤ 200，不允许 `..` 越出构建目录，不允许循环。
2. **内联本地资源**：`<link rel="stylesheet" href="./styles/app.css">`、
   `<script src="./scripts/app.js"></script>`
   - 相对路径一律按 **`src/index.html` 所在目录**解析（片段里写也一样）；
   - 内联时会自动把 JS 里的 `</script>` 转成 `<\/script>`、CSS 里的 `</style>` 转成 `<\/style>`，
     避免提前闭合标签。

片段里**不要**引 Tailwind / 第三方库 / 字体，也不要写 `<head>`：它们只在骨架里出现一次，
否则 Tailwind 会被初始化多次、库被重复加载。

## 用法

```bash
# 默认 --entry src/index.html --out dist/index.html
node scripts/build-html.mjs

# 换入口 / 产物
node scripts/build-html.mjs --entry src/report.html --out dist/report.html
```

跨平台（Windows / macOS / Linux 都能跑）、零依赖、不联网、不执行页面脚本。
**先看 `tmp/html/<slug>/` 里有没有 `scripts/build-html.mjs`**：有就直接跑，没有才从技能拷一份。

## 报告字段

stdout 是一份 JSON，`ok:false` 时退出码 1、**不写产物**（避免半成品被提交）：

| 字段 | 含义 |
| --- | --- |
| `ok` | `true` 才写 `dist/index.html` |
| `entry` / `out` | 本次用的入口与产物（相对构建目录） |
| `bytes` | 产物字节数（预览上限 1MB） |
| `files` | 参与合并的每个文件的字节数 |
| `errors[]` | 阻断项：`code` + `message` + `file` / `from`（出错位置，如 `src/index.html:12`） |
| `warnings[]` | 不阻断：样式 / 外链 / 死链接提醒 |

errors 会**一次列全**，照着修完再跑，不要一次只修一条。

## 错误码怎么修

| code | 含义 | 怎么修 |
| --- | --- | --- |
| `missing-include` | include 的文件不存在 | 补文件，或改路径（注意大小写） |
| `include-cycle` | 循环 include | 把公用的片段抽出来，别互相引 |
| `include-depth` / `include-count` | 嵌套过深 / 片段过多 | 合并层级，一节一个文件就够 |
| `path-escape` | 路径越出构建目录 | 只引用本会话目录内的文件 |
| `partial-has-document` | 片段里写了 `<!doctype>` / `<html>` / `<head>` / `<body>` | 删掉，只留 `<section>` 这一层 |
| `missing-asset` | 本地 css / js 不存在 | 补文件，或改 `href` / `src` |
| `leftover-relative` | 产物里还有相对引用 | 改 CDN、内联，或换成 `data:` URI |
| `too-large` | 产物超过 1MB | 聚合 / 抽样数据，别把原始明细整表塞进来 |

warnings 处理建议：`no-tailwind` 说明骨架漏了 Tailwind（必补）；`external-host` 说明那个域名
加载不出来（换白名单 CDN 或删掉）；`dead-link` 是页内相对跳转，预览里打不开（改成锚点或删掉）。

## 并行写片段（可选）

页面很长时，主 agent 写骨架 + `src/sections/_template.html`（一节样例），再给子助手分配文件名：

- 一个子助手只写**一个**文件，文件名由主 agent 指定（会话目录共享，不要重名）；
- 子助手只交片段，不引库、不写 `<head>`；
- 全部写完，主 agent 一次性 `node scripts/build-html.mjs` → 修 → `file-submit`。

## 一致性纪律（拆文件最容易翻车的地方）

- 颜色 / 字号 / 圆角 / 间距只在骨架的 `@theme` 或少量自定义 class 里定一次，片段只用这些 token；
- 图表 / 图标库只在骨架引一次，片段里只调全局变量；
- 每节只写自己的内容，不要复制别节的 id / `data-*`，避免重复 id；
- 卡片、表格、标题的写法以 `_template.html` 为准，别每节一套。
