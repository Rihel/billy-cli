# 工程化工具链（oxlint / oxfmt / lefthook）

> 查证优先级：**必核**（版本、命令、规则开关随配置变化）
> 依据：`.oxlintrc.jsonc`、`.oxfmtrc.json`、`lefthook.yml`、`docs/design/engineering-toolchain.md`
> 核对命令：`pnpm exec oxlint --version && pnpm exec oxfmt --version && pnpm lint && pnpm fmt:check`

## 结论

- 检查：oxlint（correctness 全 error）+ tsgolint 类型感知 5 条；`pnpm lint` / `pnpm lint:types` 必须 0/0。
- 格式化：oxfmt **精确 0.78.0**（0.x，minor 可能改输出）；单引号 / 无分号 / 2 空格 / 100 列 / LF；**md 不格式化**。
- 钩子：lefthook pre-commit（staged 格式化 + lint fix + `stage_fixed`）、commit-msg（中文类型前缀）、pre-push（`verify` + `typecheck`）。
- turbo：根任务用 `//#` 前缀注册，`pnpm turbo run lint|fmt:check|verify` 可触发全仓检查并缓存；`turbo run verify typecheck test` 是带缓存的全套。
- **没有 CI**：pre-push 是最后闸门，`--no-verify` 可绕过；命令按 CI-ready 设计。

## 坑

- `packages/*` 的 tsconfig 关了 `strictNullChecks` → `typescript/no-useless-default-assignment` 只会刷配置，已 off。
- oxfmt 没有 `[ a ]` / `${ x }` / JSX `{ x }` 的间距选项，重排会改这几类（已一次性重排并记 `.git-blame-ignore-revs`）。
- Windows：lefthook 走 Git for Windows 的 `sh -c`，`run:` 必须单行、无引号（v2.1.14 有引号截断 bug）；`{staged_files}` 过多会撞 32K 命令行上限。
- 部分暂存（`git add -p`）会被整文件 stage；大改动用 `git commit -n`。
- 普通 lint ~30ms、类型感知 ~1.5s：别把 `lint:types` 塞进 pre-commit。

## 失效信号

升级 oxlint / oxfmt / tsgolint、改 `.oxlintrc.jsonc`、引入 CI、或仓库 tsconfig 严格度变化时，
重跑本卡核对命令并更新本卡。
