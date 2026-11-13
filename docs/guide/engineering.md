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
| `pnpm verify` | lint + lint:types + fmt:check + 三道守卫 | ~2s |
| `pnpm hooks:install` | 重新安装 Git 钩子（`pnpm install` 已自动装） | 毫秒级 |

提交前最少跑一次 `pnpm verify`；改了跨包类型再跑 `pnpm typecheck`。

## 2. 工具链组成

| 工具 | 版本 | 职责 |
| --- | --- | --- |
| `oxlint` | `^1.93.0` | 语法 / 正确性 / React / Next / Vitest / import / a11y 规则 |
| `oxlint-tsgolint` | `^7.0.2007` | 类型感知规则引擎（要求 TypeScript 7+） |
| `oxfmt` | 精确 `0.78.0` | 格式化（Prettier 兼容，0.x 需钉版本） |
| `lefthook` | `^2.2.2` | Git 钩子（pre-commit / commit-msg / pre-push） |

配置位置：`.oxlintrc.jsonc`、`.oxfmtrc.json`、`.editorconfig`、`lefthook.yml`。

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
| `pre-commit` | 对暂存文件跑 `oxfmt` + `oxlint --fix`，改完自动重新 `git add` |
| `commit-msg` | 校验 `<类型>：<摘要>`（新增/重构/修复/变更/文档/测试/配置/样式/杂项），Merge/Revert/fixup 放行 |
| `pre-push` | 跑 `pnpm verify` + `pnpm typecheck` |

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
- 启动脚本已改为 Node（`scripts/start-standalone.mjs`），`db:gen` 与 `clean` 也不再依赖 `bash` / `rm -rf`。

## 7. 与既有检查的关系

```
oxlint（语法/语义） → oxfmt（排版） → tsc（类型）
check:inject（DI）  check:mastra（边界）  check:ui（前端约定）
```

`pnpm verify` 聚合 lint / lint:types / fmt:check + 三道守卫（6 道）；加上 `typecheck` / `test` 共 **8 道**。
提交钩子只跑 `verify` + `typecheck`，`test` 仍独立，避免把重活塞进 push。

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

`turbo.json` 里给根任务加了 `//#` 前缀（root task），所以 `turbo run <task>` 也能触发全仓检查，并复用 turbo 缓存：

| 命令 | 覆盖范围 |
| --- | --- |
| `pnpm turbo run lint` / `lint:types` / `fmt:check` | 单项根任务；命中缓存时 ~20ms |
| `pnpm turbo run verify` | lint + lint:types + fmt:check + 三道守卫（等同 `pnpm verify`，带缓存） |
| `pnpm turbo run verify typecheck test` | 全套：verify + 每包 typecheck + 每包 test（13 个任务，可并行/缓存） |

说明：

- lint / fmt 仍是**单进程全仓**（30ms 级），不要按包拆成 9 个任务——拆了反而慢。
  turbo 在这里提供的是统一任务图、缓存和「一条命令跑全套”，不是并行加速。
- 日常改完直接 `pnpm verify` 最快；想复用缓存、或将来接 CI，用
  `pnpm turbo run verify typecheck test`。
- root task 的缓存输入是**全仓文件哈希**（已实测），源码/配置任何改动都会让缓存失效，不会出现陈旧缓存。
