# 工程化：代码检查、格式化与提交钩子

> 方案与取舍见 [设计稿](../design/engineering-toolchain.md)；本文只讲**怎么用**。
> 工具链：oxlint（含类型感知 tsgolint）+ oxfmt + lefthook，全部 Rust/Go 原生二进制，macOS 与 Windows 直接可用。

## 1. 命令速查

| 命令 | 作用 | 耗时（本仓实测） |
| --- | --- | --- |
| `pnpm lint` | 全仓静态检查（正确性 + 插件规则） | ~30ms |
| `pnpm lint:fix` | 自动修复安全项 | ~200ms |
| `pnpm lint:types` | 类型感知检查（悬空 Promise、await 非 Promise 等） | ~1.5s |
| `pnpm fmt` | 全仓格式化 | ~40ms |
| `pnpm fmt:check` | 只检查不写入 | ~40ms |
| `pnpm verify` | 7 项：`lint` + `lint:types` + `fmt:check` + `check:inject` + `check:mastra` + `check:redis-raw` + `check:ui` | ~2s |
| `pnpm typecheck` | 逐 workspace 跑 `tsc --noEmit`（turbo，带缓存） | 按包缓存，未逐包计时 |
| `pnpm test` | 逐 workspace 跑 `vitest run`（turbo，带缓存） | 按包缓存，未逐包计时 |
| `pnpm hooks:install` | 重新安装 Git 钩子（`pnpm install` 已自动装） | 毫秒级 |

提交前最少跑一次 `pnpm verify`；改了跨包类型再跑 `pnpm typecheck`；`pnpm test` 独立跑
（钩子不跑它，见 §5）。**verify 7 项 + typecheck + test = 9 道检查**。

## 2. 工具链组成

| 工具 | 版本 | 职责 |
| --- | --- | --- |
| `oxlint` | `^1.93.0` | 语法 / 正确性 / React / Next / Vitest / import / a11y 规则 |
| `oxlint-tsgolint` | `^7.0.2007` | 类型感知规则引擎（要求 TypeScript 7+） |
| `oxfmt` | 精确 `0.78.0` | 格式化（Prettier 兼容，0.x 需钉版本） |
| `lefthook` | `^2.2.2` | Git 钩子（pre-commit / commit-msg / pre-push） |
| `turbo` | `^2.11.10` | 任务图与缓存（`typecheck` / `test` / 构建） |
| `typescript` | `^7.0.2` | 类型检查（`pnpm typecheck`） |
| `tsx` | `^4.23.15` | 直接跑 TS 脚本（`bootstrap` / `check:*` / 启动脚本） |
| Node | **≥26**（实测 26.13.0） | 运行时；`engines.node: ">=26"` |
| pnpm | `12.18.0`（`packageManager` 固定） | 包管理 |

配置位置：`.oxlintrc.jsonc`、`.oxfmtrc.json`、`.editorconfig`、`lefthook.yml`、`turbo.json`。

## 3. 规则策略

- **正确性规则（correctness）一律 error**，CI 门禁要求 0 warning 0 error。
- 额外开启：`import/no-cycle`、`eqeqeq`、`no-console`（允许 warn/error）、`no-unused-vars`（`_` 前缀豁免）。
- 类型感知只开 5 条：`no-floating-promises`、`no-misused-promises`、`await-thenable`、`no-misused-spread`、`restrict-template-expressions`。
- **显式关闭的规则都写了理由**（见 `.oxlintrc.jsonc` 注释），属于技术债台账，不是永久豁免：
  - `vitest/require-mock-type-parameters`：存量 147 处，收益低；
  - React Compiler 系列（`set-state-in-effect` / `refs` / `immutability` / `purity` / `static-components`）：聊天页状态机专项；
  - `nextjs/no-img-element`：Markdown / OSS 直链不能用 `next/image`；
  - `jsx-a11y/prefer-tag-over-role`：布局原语需要 `div` + role，换语义标签会破坏样式与嵌套；
  - `typescript/unbound-method` / `no-base-to-string` / `no-redundant-type-constituents`：误报多；
  - `typescript/no-useless-default-assignment`：`packages/*` 关闭了 `strictNullChecks`，规则只会刷配置。

确需豁免某一行时，用**单行**注释并写理由：

```ts
// oxlint-disable-next-line react-hooks/exhaustive-deps -- 只依赖 nonce，依赖整个 focus 会每次渲染重跑
useEffect(() => { ... }, [focus?.nonce])
```

**不要**用文件级 `/* oxlint-disable */` 或改全局规则来绕开问题；`reportUnusedDisableDirectives` 会把过期注释揪出来。

## 4. 格式化约定

```
单引号、无分号、2 空格、行宽 100、尾逗号 all、LF 行尾
```

- 范围：js / ts / tsx / json / jsonc / yaml / css；**Markdown 不格式化**（手写文档避免无意义重排）。
- 排除：`pnpm-lock.yaml`、`next-env.d.ts`、`apps/admin/public/vendor`、`*.min.js`、`dist`、`.next`。
- 编辑器：装 `oxc.oxc-vscode`，保存时自动格式化（`.vscode` 已配好）。
- 升级 `oxfmt` 必须改精确版本，并在单独提交里重排全仓——0.x 的输出可能随 minor 变化。

## 5. 提交钩子

`pnpm install` 时 lefthook 自动安装；也可 `pnpm hooks:install` 手动装。

| 钩子 | 行为 |
| --- | --- |
| `pre-commit` | **两个 job 并行**：`oxfmt`（format，`stage_fixed`）与 `oxlint --fix`（lint，`stage_fixed`），各自按 glob 只处理暂存文件，改完自动重新 `git add` |
| `commit-msg` | `node scripts/check-commit-msg.ts {1}` 校验 `<类型>：<摘要>`；类型限 **9 种**：新增 / 重构 / 修复 / 变更 / 文档 / 测试 / 配置 / 样式 / 杂项；摘要 ≤50 字；Merge / Revert / fixup / squash 放行 |
| `pre-push` | 跑 `pnpm verify` + `pnpm typecheck`（**不跑 `pnpm test`**，避免把重活塞进 push） |

**跳过钩子**（自担风险，没有 CI 兜底）：

```bash
# Git Bash / macOS / Linux
LEFTHOOK=0 git commit ...
git commit -n ...
git push --no-verify

# PowerShell
$env:LEFTHOOK=0; git commit ...

# cmd
set LEFTHOOK=0 && git commit ...
```

### 已知限制

- **部分暂存**：`git add -p` 只暂存了半个文件时，钩子格式化的是磁盘整文件，`stage_fixed` 会把未暂存部分一起 stage。大改动用 `git commit -n` 分步提交。
- **staged 文件过多**：Windows 命令行约 32K 上限，一次暂存上千文件可能超；分批提交，或 `git commit -n` 后单独跑 `pnpm fmt`。
- **钩子被绕过**：`pre-push` 是最后一道闸门；绕过等于接受 main 变红。

## 6. Windows / macOS 说明

- 四个工具都有三平台原生二进制；Windows 需要 **Git for Windows**（钩子靠它自带的 `sh` 执行），不需要 WSL。
- 行尾统一 LF：`.gitattributes` + `.editorconfig` + oxfmt `endOfLine: "lf"` 三重约束；`*.bat` / `*.cmd` 保持 CRLF。
- 若 Windows 首次安装被 pnpm 的 supply-chain 策略拦下平台绑定，把对应 `@oxlint/binding-win32-*`、`@oxfmt/binding-win32-*`、`@oxlint-tsgolint/win32-*`、`lefthook-windows-*` 加进 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`。
- 启动脚本已改为 Node（`scripts/start-standalone.ts`、`scripts/kill-ports.ts`），`db:gen` 与 `clean` 也不再依赖 `bash` / `rm -rf`。

## 7. 与既有检查的关系

```
oxlint（语法/语义） → oxfmt（排版） → tsc（类型）
check:inject（DI）  check:mastra（边界）  check:redis-raw（Redis 入口）  check:ui（前端约定）
```

`pnpm verify` = 7 项（`lint` / `lint:types` / `fmt:check` + **四道守卫** `check:inject` / `check:mastra` /
`check:redis-raw` / `check:ui`）；加上 `typecheck` / `test` 共 **9 道**。
提交钩子只跑 `verify` + `typecheck`，`test` 仍独立，避免把重活塞进 push。

四道守卫各自守什么：

| 守卫 | 守什么 |
| --- | --- |
| `check:inject` | 构造器注入必须带 `@Inject`、provider 必须 `@Injectable`（DI 静默失效排查） |
| `check:mastra` | `@mastra/*` 只允许出现在 runtime 的 mastra 适配层（执行面边界） |
| `check:redis-raw` | `apps/*` 禁止直接用 redis 客户端 `.raw`，统一走 `RedisStore` |
| `check:ui` | 前端 5 条不变量（见 [frontend.md](./frontend.md) 的设计系统一节） |

## 8. 调整规则的流程

1. 先改 `.oxlintrc.jsonc`（或 `.oxfmtrc.json`），跑 `pnpm verify` 看影响面；
2. 规则变更与代码修复放同一个提交，提交信息写清「为什么开/关」；
3. 同步更新本文与 [设计稿](../design/engineering-toolchain.md) 的规则表；
4. 新增的关闭项必须写理由，并进技术债台账。

## 9. VS Code 配置

### 仓库级（提交在 `.vscode/`）

推荐扩展（`.vscode/extensions.json`）：

| 扩展 | 作用 |
| --- | --- |
| `oxc.oxc-vscode` | lint + format 同一个扩展，保存即修 |
| `bradlc.vscode-tailwindcss` | Tailwind 类名提示（仓库已在 `tailwindCSS.include` 限定范围） |
| `editorconfig.editorconfig` | 让编辑器遵守 `.editorconfig`（LF / 2 空格） |
| `vitest.explorer` | 单测面板 |

`.vscode/settings.json` 关键项：

```jsonc
{
  "editor.defaultFormatter": "oxc.oxc-vscode",
  "editor.formatOnSave": true,
  "editor.formatOnSaveMode": "file",
  "editor.codeActionsOnSave": { "source.fixAll.oxc": "explicit" },
  "files.eol": "\n",
  "eslint.enable": false,   // 本仓不用 ESLint，避免与 oxlint 双跑
  "prettier.enable": false, // 本仓不用 Prettier
  "[markdown]": { "editor.formatOnSave": false }
}
```

### 用户级（本机 `settings.json`，跨项目）

本仓库的工具只应该在**有配置的项目**里生效，所以本机全局配置采用「按需启用」：

```jsonc
{
  "oxc.requireConfig": true,     // 只有项目里有 .oxlintrc.* / oxlint.config.ts 才启动
  "oxc.lint.run": "onSave",      // 保存时 lint（onType 在类型感知下偏重）
  "oxc.fixKind": "safe_fix",     // 只应用安全修复
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": "explicit",  // 其它项目继续用 ESLint
    "source.fixAll.oxc": "explicit"      // 本仓等有 oxlint 配置的项目用 oxc
  }
}
```

全局默认格式化器仍保留 Prettier（CSS / Vue / Markdown / SQL 等语言继续用它）；本仓通过
`.vscode/settings.json` 覆盖为 oxc。两个格式化器不会同时跑——`prettier.enable: false` 已在仓库级关掉。

### 本机扩展整理建议

| 扩展 | 建议 | 原因 |
| --- | --- | --- |
| `HookyQR.beautify` | 卸载 | 停更多年；`[css]` / `[less]` 已改走 Prettier |
| `shakram02.bash-beautify` | 卸载 | 停更；`[shellscript]` 已改走 `foxundermoon.shell-format` |
| `rvest.vs-code-prettier-eslint` | 卸载 | 先 Prettier 再 ESLint 的包装，和独立 Prettier + ESLint 冲突 |
| `octref.vetur` | 视 Vue 版本决定 | Vetur 只支持 Vue 2；Vue 3 应换 `Vue.volar` |
| `heybourn.headwind` | 可选卸载 | Tailwind 类名排序，和 `oxfmt` 的 `sortTailwindcss`（未来开启）职责重叠 |

## 10. 用 turbo 跑检查

`turbo.json` 的 tasks 是 `dev` / `build` / `build:docker` / `typecheck` / `test`；**根任务（`//#` 前缀）7 个**：
`//#lint`、`//#lint:types`、`//#fmt:check`、`//#check:inject`、`//#check:mastra`、`//#check:ui`、`//#verify`。
**没有 `//#check:redis-raw`** —— 它仍由 `//#verify` 里跑的 `pnpm verify` 覆盖，只是不能单独当作 turbo 任务命中缓存。
所以 `turbo run <task>` 也能触发全仓检查，并复用 turbo 缓存：

| 命令 | 覆盖范围 |
| --- | --- |
| `pnpm turbo run lint` / `lint:types` / `fmt:check` | 单项根任务；命中缓存时 ~20ms |
| `pnpm turbo run verify` | 等同 `pnpm verify`（7 项，带缓存） |
| `pnpm turbo run check:redis-raw` | **会报错**（`Could not find task`）：没有对应根任务，直接 `pnpm check:redis-raw` |
| `pnpm turbo run verify typecheck test` | 全套：verify + 每包 typecheck + 每包 test（**37 个任务**：1 个根任务 + 17 个声明了 `typecheck` 的 workspace + 19 个声明了 `test` 的 workspace，可并行/缓存） |

说明：

- lint / fmt 仍是**单进程全仓**（30ms 级），不要按包拆成二十个任务——拆了反而慢。
  turbo 在这里提供的是统一任务图、缓存和「一条命令跑全套」，不是并行加速。
- 日常改完直接 `pnpm verify` 最快；想复用缓存、或将来接 CI，用
  `pnpm turbo run verify typecheck test`。
- root task 的缓存输入是**全仓文件哈希**（已实测），源码/配置任何改动都会让缓存失效，不会出现陈旧缓存。
