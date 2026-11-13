---
name: code-quality
description: Billy 工程的代码检查、格式化与提交钩子规范：oxlint（含类型感知 tsgolint）/ oxfmt / lefthook 的命令、规则取舍、豁免方式、钩子行为与 Windows 兼容。触发词：lint、oxlint、eslint、格式化、format、oxfmt、prettier、代码风格、告警、no-unused-vars、类型感知、type-aware、钩子、hook、lefthook、commit hook、verify、提交前检查。
---

# 代码检查 / 格式化 / 提交钩子

前置：先加载必读 skill `billy-dev-foundation`（工程约定与标准流程）。
方案与取舍见 [设计稿](../../../docs/design/engineering-toolchain.md)，使用与排错见
[工程化指南](../../../docs/guide/engineering.md)。

## 命令

| 命令 | 作用 | 耗时 |
| --- | --- | --- |
| `pnpm lint` / `pnpm lint:fix` | oxlint 全仓检查 / 自动修复；correctness 全部 error | ~200ms |
| `pnpm lint:types` | 类型感知（tsgolint），只开 5 条高价值规则 | ~2s |
| `pnpm fmt` / `pnpm fmt:check` | oxfmt 全仓格式化 / 只检查 | ~20ms |
| `pnpm verify` | lint + lint:types + fmt:check + 三道 check 守卫 | ~2s |
| `pnpm hooks:install` | 手动重装 lefthook 钩子（`pnpm install` 已自动） | 毫秒级 |
| `pnpm turbo run verify typecheck test` | 走 turbo 缓存的全套检查（root task `//#verify`） | 命中缓存 ~20ms |

## 硬性规则

1. **0 warning 0 error**：`pnpm lint` 与 `pnpm lint:types` 必须干净；不许为过关关规则或加文件级 disable。
2. **不手写风格**：缩进 / 引号 / 换行交给 `pnpm fmt`；提交时 pre-commit 也会自动修。
3. **豁免方式**：确需豁免用单行 `// oxlint-disable-next-line <rule> -- 中文理由`；优先改语义。
4. **规则开关**：改 `.oxlintrc.jsonc` 必须写明理由；关闭项进技术债台账；类型感知只放高价值规则。
5. **格式化范围**：ts / tsx / js / mjs / json / jsonc / yaml / css；**md 不格式化**；单引号 / 无分号 / 2 空格 / 100 列 / LF。
6. **钩子**：pre-commit 对 staged 文件自动 fmt + lint fix 并重新 stage；commit-msg 校验
   `<类型>：<摘要>`；pre-push 跑 `verify` + `typecheck`（本仓没有 CI，pre-push 是最后一道）。
7. **部分暂存**：`git add -p` 时钩子格式化的是磁盘整文件，`stage_fixed` 会把未暂存部分一起 stage；
   大改动用 `git commit -n` 分步提交。
8. **Windows**：钩子依赖 Git for Windows 自带的 `sh`；`lefthook.yml` 的 `run:` 必须单行、无引号
   （lefthook v2 的转义 bug）；`{staged_files}` 过多会撞 32K 命令行上限。
9. **编辑器**：VS Code 用 `oxc.oxc-vscode`；本仓已关 `eslint.enable` / `prettier.enable`，不要另起一套。

## 调整流程

改规则或格式化选项时：改配置 → `pnpm verify` 看影响面 → 同步修代码 → 更新
`docs/guide/engineering.md` 与设计稿的规则表 → 在同一个提交里说明理由。

## 参考文件

| 文件 | 内容 |
| --- | --- |
| [engineering.md](../../../docs/guide/engineering.md) | 命令、规则取舍、钩子、Windows、VS Code（出问题先看） |
| [engineering-toolchain.md](../../../docs/design/engineering-toolchain.md) | 选型对比、配置明细、落地记录 |
| `.oxlintrc.jsonc` / `.oxfmtrc.json` / `lefthook.yml` | 事实源 |

## 完成检查清单

- [ ] `pnpm verify` 通过（lint / lint:types / fmt:check / 三道守卫）
- [ ] 没有新增文件级 disable；单行豁免都带中文理由
- [ ] 改动规则 / 格式化选项时，README、guide、设计稿已同步
- [ ] 提交信息符合 `<类型>：<摘要>`（commit-msg 钩子会校验）
