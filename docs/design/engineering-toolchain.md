# 工程化工具链：代码检查 / 格式化 / 提交钩子

> 目标：给仓库补上「机器能自动查的」那一层——lint、format、提交前修复、提交信息校验。
> 原则：**文档先行**（本文评审通过后再动代码）；**不引入 CI**（本轮明确不做，见 §9）。
>
> 选型结论：**oxlint + oxlint-tsgolint + oxfmt + lefthook**。
> 所有数字为 2026-11-13 在本仓（1038 个源文件、Node 26.13、pnpm 12.18、TS 7.0.2）实测。

## 1. 现状与缺口

当前仓库**没有任何 lint / format 工具**：

| 项 | 现状 | 证据 |
| --- | --- | --- |
| Lint | 无配置、无依赖 | 根目录与各包均无 `eslint*` / `oxlint*` 配置 |
| Format | 无配置、无依赖 | 仅剩 `apps/server/.prettierrc` 一个历史残留（无 prettier 依赖，纯误导） |
| 提交钩子 | 无 | `.git/hooks` 只有 `*.sample` |
| 质量检查 | 五道，但都是**自研守卫** | `check:inject` / `check:mastra` / `check:ui` + `typecheck` / `test` |
| CI | 无 | 仓库无 `.github/` |

缺口带来的实际问题：

1. **风格无事实标准**：单引号为主（684 个 ts 文件），但 tsx 里双引号 144 / 单引号 133；分号几乎全仓不用（仅 20 个文件带行尾分号）。没有工具时靠人眼和 AI 各自发挥。
2. **低价值缺陷靠 review 发现**：未使用变量、`==`、无意义 spread、悬空 Promise、循环依赖，机器本该直接拦。
3. **提交信息靠自觉**：`git-workflow` skill 规定了中文类型前缀，但没有机器校验。
4. **类型检查只覆盖类型**：`tsc` 查不出「await 了非 Promise」「Promise 没 await」这类语义问题。

**主要矛盾**：不是「缺工具」，而是**缺一套与本仓 TS 7 / Node 26 / pnpm 12 兼容、且维护成本低的工具链**。ESLint + Prettier 在这个组合下已经出现硬冲突（见 §2）。

## 2. 选型与取舍

### 2.1 候选对比

| 维度 | oxlint + oxfmt | Biome 2.6 | ESLint 10 + Prettier 3.10 |
| --- | --- | --- | --- |
| 速度（本仓实测） | 27ms（默认）/ 1.5s（类型感知）/ 34ms（format 检查） | 毫秒级（Rust 单二进制） | 数十秒级（外部实测 67s） |
| 类型感知 | tsgolint，59/61 条 typescript-eslint 规则，**要求 TS 7+** | 自研 inference engine，不依赖 tsc；关键规则多数在 nursery，需逐条点名开启 | 规则最全，但 **peer 不支持 TS 7** |
| 本仓兼容性 | ✅ TS 7.0.2 直接可用 | ✅ 可用 | ❌ `typescript-eslint@8.72.2` peer 为 `typescript >=4.8.4 <6.1.0` |
| 插件覆盖 | 原生：react / react-hooks / nextjs / vitest / import / jsx-a11y / promise / node / unicorn | 插件生态较小 | 最全（`naming-convention`、`no-restricted-syntax`、`jsx-no-bind` 等独有） |
| 成熟度 | oxlint 稳定周更；**oxfmt 仍 0.x beta** | 2.x 稳定 | 最稳 |
| 配置面 | 1 个 lint 配置 + 1 个 format 配置 | 1 个 `biome.json` | flat config + 一堆插件 |

### 2.2 结论

- **Lint 用 oxlint**：本仓 1038 个文件 27ms，类型感知 1.5s；原生插件已覆盖本项目用到的 React / Next / Vitest / 分层依赖。
- **Format 用 oxfmt**（用户已定）：34ms 跑完全仓，Prettier 的 JS/TS 一致性套件 100% 通过；用同一个 oxc 工具链，只维护一套版本。
- **类型感知用 oxlint-tsgolint**：它要求 TS 7+，与本仓一致；ESLint 路线则要为了 lint 把 TS 降到 6.0 以下，代价不可接受。
- **ESLint / Prettier 不引入**：不是「过时」，而是在本仓的 TS 7 约束下不可行 / 性价比低。若将来必须用只有 ESLint 才有的规则（如 `naming-convention`），再单独评估 `@typescript/typescript6` 兼容层，不提前背这个包。
- **Biome 作为备选**：如果 oxfmt 0.x 的输出漂移难以接受，可随时切到 Biome 2.6 的 formatter（lint 仍是 oxlint 或改用 Biome，届时单独评估）。

### 2.3 版本与依赖

| 包 | 版本 | 说明 |
| --- | --- | --- |
| `oxlint` | `^1.93.0` | 周更，caret 可跟 |
| `oxlint-tsgolint` | `^7.0.2007` | 类型感知引擎，版本与 oxlint 分开跟 |
| `oxfmt` | `0.78.0`（**精确**） | 0.x 语义：minor 可能改输出，升级单独 PR + 重排 |
| `lefthook` | `^2.2.2` | Go 二进制，钩子管理器 |
| `pnpm-workspace.yaml` | `allowBuilds: lefthook: true` | 允许 lefthook 的 postinstall 安装钩子（CI 环境变量下会自动跳过） |

> 平台绑定以 optionalDependencies 分发（darwin / win32 / linux 各自的二进制），pnpm 按当前平台安装；另见 §3.8 的跨平台约束。

## 3. 方案：分层设计

### 3.1 静态检查（oxlint）

**文件**：`.oxlintrc.jsonc`（带中文注释，允许注释）

```jsonc
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["eslint", "typescript", "unicorn", "import", "react", "react-hooks",
              "jsx-a11y", "nextjs", "vitest", "promise", "node", "oxc"],
  "categories": { "correctness": "error" },   // 默认 warn → 升为门禁
  "env": { "es2026": true, "node": true, "browser": true },
  "options": { "reportUnusedDisableDirectives": "warn" },
  "ignorePatterns": ["**/dist/**", "**/.next/**", "apps/admin/public/vendor/**",
                     "apps/web/next-env.d.ts"],
  "rules": {
    "import/no-cycle": "error",
    "eqeqeq": ["error", "smart"],
    "no-console": ["error", { "allow": ["warn", "error"] }],
    "no-unused-vars": ["error", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_",
                                  "caughtErrors": "none", "ignoreRestSiblings": true }]
  },
  "overrides": [
    { "files": ["**/*.test.ts", "**/*.test.tsx", "**/test/**"],
      "rules": { "typescript/no-non-null-assertion": "off",
                 "vitest/no-conditional-expect": "off" } },
    { "files": ["apps/server/src/database/migrations/**"], "rules": { "no-console": "off" } },
    { "files": ["scripts/**", "**/scripts/**", "**/*.config.*"], "rules": { "no-console": "off" } }
  ]
}
```

**显式关闭的规则（附理由，进技术债台账）**：

| 规则 | 存量 | 关闭理由 |
| --- | --- | --- |
| `vitest/require-mock-type-parameters` | 147 | 只要求 `vi.fn<T>()` 显式泛型，收益低于改造面 |
| `react/set-state-in-effect` / `refs` / `immutability` / `purity` / `static-components` | 64 | React Compiler 系列，聊天页状态机大量 setState-in-effect，属专项治理 |
| `nextjs/no-img-element` | 13 | Markdown / OSS 直链场景不能走 `next/image` |
| `jsx-a11y/prefer-tag-over-role` | 14 | 启发式规则；布局原语（列表容器 / 按钮组 / 上传区）换语义标签会破坏布局与嵌套约束 |
| `typescript/unbound-method` | 34 | 对解构出来的箭头函数误报 |
| `typescript/no-base-to-string` | 58 | 表单/字典组件里对 `unknown` 取字符串，属正常兜底 |
| `typescript/no-redundant-type-constituents` | 39 | 存量类型写法，收益低 |
| `typescript/no-useless-default-assignment` | 210 | `packages/*` 关闭了 `strictNullChecks`，规则只刷配置 |

**门禁**：`pnpm lint` 必须 **0 warning 0 error**；存量 128 条在 P2 清零。

### 3.2 类型感知检查（tsgolint）

独立命令 `pnpm lint:types`（`oxlint --type-aware`），只保留高价值规则：

| 规则 | 存量 | 价值 |
| --- | --- | --- |
| `typescript/no-floating-promises` | 22 | 漏 `await` / 漏 `catch` 的真 bug |
| `typescript/no-misused-promises` | 0 | Promise 传给非 Promise 位置（if / 事件处理器） |
| `typescript/await-thenable` | 28 | `await` 了非 Promise，多为冗余 |
| `typescript/no-misused-spread` | 8 | 展开 Promise / 数组到对象 |
| `typescript/restrict-template-expressions` | 8 | 模板字符串里拼对象 |

**为什么单独一条命令、不并进 `lint`**：类型感知要跑 tsconfig 全项目（本仓 1.5s），pre-commit 只该跑毫秒级检查；且它依赖构建产物/类型解析，更适合 pre-push。

### 3.3 格式化（oxfmt）

**文件**：`.oxfmtrc.json` + `.editorconfig`

```jsonc
{
  "$schema": "./node_modules/oxfmt/configuration_schema.json",
  "printWidth": 100, "tabWidth": 2, "useTabs": false, "endOfLine": "lf",
  "semi": false, "singleQuote": true, "jsxSingleQuote": false,
  "trailingComma": "all", "bracketSpacing": true, "arrowParens": "always",
  "sortPackageJson": false, "sortImports": false,
  "ignorePatterns": ["**/*.md", "pnpm-lock.yaml", "apps/web/next-env.d.ts",
                     "apps/admin/public/vendor/**", "**/*.min.js"]
}
```

取值依据（贴合存量，减少无意义 churn）：

| 选项 | 取值 | 依据 |
| --- | --- | --- |
| `semi` | `false` | 全仓仅 ~20 个文件带行尾分号 |
| `singleQuote` | `true` | 684 个 ts 文件单引号 vs 29 个双引号 |
| `printWidth` | `100` | 全仓 87% 的行 ≤100，最大值集中在长字符串 |
| `trailingComma` | `all` | 与 `apps/server/.prettierrc` 历史约定一致 |

**范围**：js / ts / tsx / json / jsonc / yaml / css；**先排除 `**/*.md`**（178 个手写文档，重排只产生噪音），后续可单独开。
**一次性动作**：全仓 615 个文件需重排（ts 365 / tsx 228 / json 10 / yaml 5 / css 4 / mjs 2 / jsonc 1），单独一个 commit，并把该 commit 写入 `.git-blame-ignore-revs`。
**本轮不开**：`sortImports`（会与现有 import 分组约定冲突）、`sortTailwindcss`（Tailwind 4 类名排序，单独专项）、`sortPackageJson`（避免无关 diff）。

### 3.4 提交钩子（lefthook）

**文件**：`lefthook.yml`、`scripts/check-commit-msg.ts`

```yaml
pre-commit:
  parallel: true
  jobs:
    - name: format
      glob: "*.{ts,tsx,js,mjs,cjs,json,jsonc,yaml,yml,css}"
      run: pnpm exec oxfmt --no-error-on-unmatched-pattern {staged_files}
      stage_fixed: true
    - name: lint
      glob: "*.{ts,tsx,js,mjs,cjs}"
      run: pnpm exec oxlint --fix {staged_files}
      stage_fixed: true

commit-msg:
  jobs:
    - name: 提交信息规范
      run: node scripts/check-commit-msg.ts {1}

pre-push:
  jobs:
    - name: verify
      run: pnpm verify && pnpm typecheck
```

- `stage_fixed: true`：格式化/修复后重新 `git add`，否则提交进去的仍是旧内容。
- commit-msg 校验 `<类型>：<摘要>`（新增/重构/修复/变更/文档/测试/配置/样式/杂项），Merge / Revert / fixup / squash 放行。
- **没有 CI，pre-push 是最后一道闸门**：`verify`（lint + 类型感知 + fmt:check + 三道守卫）约 2s，`typecheck` 走 turbo 缓存。
- 逃生口（按 shell 选择写法）：Git Bash `LEFTHOOK=0 git commit`、PowerShell `$env:LEFTHOOK=0; git commit`、cmd `set LEFTHOOK=0 && git commit`；或直接 `git commit -n` / `git push --no-verify`。绕过即自担风险，写进文档。
- 已知通病：`git add -p` 部分暂存时，钩子格式化的是磁盘整文件，`stage_fixed` 会把未暂存部分一起 stage。大改动建议 `-n` 分步提交。

### 3.5 命令与脚本

`package.json` 新增：

```json
{
  "lint": "oxlint",
  "lint:fix": "oxlint --fix",
  "lint:types": "oxlint --type-aware",
  "fmt": "oxfmt",
  "fmt:check": "oxfmt --check",
  "verify": "pnpm lint && pnpm lint:types && pnpm fmt:check && pnpm check:inject && pnpm check:mastra && pnpm check:ui",
  "hooks:install": "lefthook install"
}
```

| 命令 | 用途 | 耗时（实测） |
| --- | --- | --- |
| `pnpm lint` | 全仓静态检查 | 27ms（加插件 375ms） |
| `pnpm lint:fix` | 自动修复安全项 | ~200ms |
| `pnpm lint:types` | 类型感知精选规则 | 1.5s |
| `pnpm fmt` / `pnpm fmt:check` | 格式化 / 只检查 | 34ms |
| `pnpm verify` | 本地一站式门禁 | ~2s |
| `pnpm hooks:install` | 手动重装钩子（postinstall 已自动） | 毫秒级 |

### 3.6 编辑器协作

- `.vscode/extensions.json` 推荐 `oxc.oxc-vscode`（lint + format 同一个扩展）。
- `.vscode/settings.json`：`editor.defaultFormatter: "oxc.oxc-vscode"`、`formatOnSave: true`、`source.fixAll.oxc`；markdown 不格式化（与 oxfmt 排除范围一致）。
- `.editorconfig`：LF、2 空格、100 列、md 不 trim、`*.bat` 保持 CRLF（与 `.gitattributes` 对齐）。
- 删除 `apps/server/.prettierrc`。

### 3.7 与既有五道检查的关系

不是替代，是补位：

```
oxlint（语法/语义/风格）  →  oxfmt（排版）  →  tsc（类型）
check:inject（DI 约定）   check:mastra（边界）   check:ui（前端约定）
```

`pnpm verify` 把「机器能查的」聚合成一条命令；`typecheck` / `test` 仍独立，避免把重活塞进钩子。

### 3.8 跨平台（macOS / Windows）

**结论：四个工具都有三平台原生二进制，Windows 不需要 WSL（但钩子执行需要 Git for Windows 自带的 `sh`）；要按下面四个约束设计，否则会在 Windows 上翻车。**

| 约束 | 事实 | 对策 |
| --- | --- | --- |
| 原生二进制 | `oxlint` / `oxfmt` / `oxlint-tsgolint` / `lefthook` 的 npm 元数据都带 `darwin-arm64/x64`、`win32-x64/arm64`、`linux-*` 的 optionalDependencies（2026-11-13 核对） | 不写 `supportedArchitectures`（会裁掉别的平台绑定）；`pnpm-workspace.yaml` 的 supply-chain 策略若拦新平台包，把对应 `@oxlint/binding-win32-*`、`@oxfmt/binding-win32-*`、`@oxlint-tsgolint/win32-*`、`lefthook-windows-*` 加进 `minimumReleaseAgeExclude` |
| 钩子执行器 | Windows 上 lefthook 通过 Git for Windows 自带的 `sh -c` 执行 `run:`；2.1.14 有过「脚本参数未转义、引号截断命令」的 bug | 用 2.2.x；`run:` 全部保持**单行、无引号、无 `\|`/`>` 块**；多步逻辑放 Node 脚本，不写 shell 脚本 |
| 路径与长度 | Git Bash 传 `C:/...`；空格路径；Windows 命令行上限约 32K（`{staged_files}` 文件多时可能超） | 脚本用 `node:path` / `fileURLToPath`，不手工拼 `/`；commit-msg 支持参数缺失时回落 `git rev-parse --git-path COMMIT_EDITMSG`；大提交（P3 全仓重排）用 `git commit -n` |
| 行尾 / 编码 | 仓库 `.gitattributes` 已 `* text=auto eol=lf`，但 Windows 编辑器仍可能写 CRLF | `.editorconfig` 强制 LF；oxfmt 显式 `endOfLine: "lf"`（覆盖 editorconfig）；commit-msg 脚本 strip BOM 与 `\r` |

**npm scripts 的跨平台写法**：只用 `&&`、`oxlint`、`oxfmt`、`node` 这类两端都有的命令；**不新增** `rm -rf`、`bash -c`、`$(...)`、`NODE_ENV=x` 前缀。存量 `db:generate`（`bash -c`）与 web/admin 的 `start`（`sh scripts/*.sh`）是既有债务，Windows 上需要 Git Bash；后续可改 Node 脚本，不在本轮范围。

**Windows 冒烟清单（P1 / P4 验收时执行）**：

```bash
pnpm install                    # 装上 win32 绑定，钩子自动安装
pnpm lint                       # 0 warning 0 error
pnpm lint:types                 # 0 warning 0 error
pnpm fmt:check                  # 干净
pnpm verify                     # 通过
git commit -m "配置：接入 oxlint 与 oxfmt"   # pre-commit 自动修复并重新 stage
git commit -m "update"          # 被 commit-msg 拒绝
```

本轮没有 CI，Windows 无法自动回归，只能按上面清单人工验收；将来补 CI 时加一个 `windows-latest` job 即可。

### 3.9 本轮不做

| 不做 | 原因 |
| --- | --- |
| **CI（GitHub Actions）** | 用户明确本轮不要；命令已按 CI-ready 设计，将来补一个 workflow 文件即可 |
| Markdown / YAML 之外的文档格式化 | 178 个手写文档重排纯噪音 |
| import 排序 / Tailwind 类名排序 | 与现有分组约定冲突，单独专项 |
| `strictNullChecks` 统一 | 会影响全仓类型，属独立工程 |
| React Compiler 规则治理 | 聊天页状态机专项 |
| knip（未使用依赖） | 可选后续，先清掉已知的 `apps/server` 无用 `typescript-eslint` |
| 发布流水线 / changesets / publint | 本仓不是发布库 |

## 4. 落地顺序

每一步独立可回滚，做完停一次给用户验。

| 阶段 | 内容 | 改动面 | 验收 |
| --- | --- | --- | --- |
| **P1 配置** | `.oxlintrc.jsonc`、`.oxfmtrc.json`、`.editorconfig`、`.vscode/*`、package.json 脚本、`pnpm-workspace.yaml` allowBuilds、删 `.prettierrc` | 7 个文件，**零源码改动** | `pnpm lint` 能跑出 128 条基线；`pnpm fmt:check` 报 615 个文件；macOS 实测 + Windows 按 §3.8 冒烟清单 |
| **P2 清存量** | 按规则逐条修 128 条 lint + 60 条类型感知；有意保留处用单行 disable + 理由 | ~80 个源码文件 | `pnpm lint` 与 `pnpm lint:types` 均 0/0；`pnpm typecheck` 通过 |
| **P3 全仓排版** | `pnpm fmt`，单独 commit；`.git-blame-ignore-revs` 记录该 commit | 615 个文件，纯格式 | `pnpm fmt:check` 干净；`git diff` 无逻辑改动；Windows 检出后 `fmt:check` 仍干净（验证 LF） |
| **P4 钩子** | `lefthook.yml`、`scripts/check-commit-msg.ts`、安装钩子 | 2 个文件 | 故意提交坏格式 / 坏 message 被拦；`pnpm verify` 通过；Windows 提交链路按 §3.8 跑通 |
| **P5 文档同步** | `docs/guide/engineering.md`、README 贡献段、skill 命令表、memory 卡片、dev-log | 文档 | 命令与文档一致 |

**顺序理由**：P2 必须在 P3 前（语义修复与格式重排分开 review）；P1 先行是因为它零风险且能立刻看到基线。

## 5. 验证方式

```bash
pnpm lint          # 期望：Found 0 warnings and 0 errors
pnpm lint:types    # 期望：Found 0 warnings and 0 errors
pnpm fmt:check     # 期望：无 "Format issues found"
pnpm typecheck     # 期望：全部包通过
pnpm verify        # 一条命令覆盖以上 + 三道守卫
```

钩子验证（macOS / Git Bash 语法；PowerShell 逃生口写法见 §3.4）：

1. 手改一个文件的缩进 → `git commit` → 钩子自动修回并 stage；
2. `git commit -m "update"` → 被 commit-msg 拒绝；
3. `git commit -m "配置：接入 oxlint 与 oxfmt"` → 通过；
4. `git push` → 跑 `verify` + `typecheck`。

Windows 侧另按 §3.8 的冒烟清单执行（含 win32 绑定安装、CRLF 归一、提交链路）。

## 6. 风险与对策

| 风险 | 对策 |
| --- | --- |
| oxfmt 仍 0.x，升级可能改输出 | 精确版本；升级单独 PR 并重排；CI-ready 的 `fmt:check` 可随时接 |
| 全仓重排与在途分支冲突 | 一次性集中做，提前通知；冲突用「重跑 fmt」机械解决 |
| 部分暂存被整文件 stage | 文档写明；大改动用 `git commit -n` |
| 钩子被绕过导致 main 变红 | pre-push 兜底；后续补 CI（本次不做） |
| `packages/*` 的 `strictNullChecks: false` 造成类型感知误报 | 关闭 `no-useless-default-assignment`，并在文档记债 |
| oxlint 周更带来规则变化 | 升级时看 changelog + 跑 `pnpm verify`；不自动跟随 |
| Windows 钩子转义 / 命令行超长 | `run:` 单行无引号无块标量；多步逻辑进 Node 脚本；大提交用 `git commit -n`；`{staged_files}` 过多时分批提交 |
| Windows 首次安装被 supply-chain 策略拦平台绑定 | 按 §3.8 把对应 `win32-*` 包加进 `minimumReleaseAgeExclude`（pnpm 通常会自动补） |
| Windows 检出后行尾漂移导致 `fmt:check` 报错 | `.gitattributes` + `.editorconfig` + oxfmt `endOfLine: "lf"` 三重约束；提交前钩子会归一 |

## 7. 默认值（可改）

| 决策点 | 默认 |
| --- | --- |
| Formatter | **oxfmt**（已定） |
| 是否全仓重排 | 是，单独 commit + `.git-blame-ignore-revs` |
| 存量 lint | 一次清零，不冻结基线 |
| pre-push | 跑 `verify` + `typecheck` |
| CI | 本轮不做 |

## 8. 落地记录（2026-11-13）

- 实际落地：P1、P2、P4、P5、P6；P3 与 P2 落在同一批工作区改动里（先修语义、后全仓 oxfmt），未拆提交。
- 验证结果：
  - `pnpm lint` 0 warning 0 error（201 rules）
  - `pnpm lint:types` 0 warning 0 error（213 rules）
  - `pnpm fmt:check` 1080 个文件全部合规
  - `pnpm typecheck` 5/5、`pnpm test` 7/7（1272 个用例）、`pnpm verify` 通过
- 格式化：692 个文件改动（ts / tsx / json / yaml / css / mjs；md 与 lockfile 排除）。
- 偏差与修正：
  1. oxfmt 把 JSX 属性拆行后，18 条行级 disable 注释失去作用 → `jsx-a11y/prefer-tag-over-role` 改为全局关闭（启发式规则，布局原语确需 `div`），`no-autofocus` 改文件级 disable（3 个弹窗），控制字符正则抽成常量后单行 disable。
  2. 因为「先修告警、后全仓格式化」，P3 没有独立成 commit；若之后要按 `.git-blame-ignore-revs` 忽略，需要单独再跑一次纯格式化提交，**不要**把混合提交写进 ignore 列表。
  3. CI 按约定未做；`verify` / `lint` / `fmt:check` 命令可直接复用到将来的 workflow。
