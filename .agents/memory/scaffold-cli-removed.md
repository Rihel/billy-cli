# scaffold-cli-removed

**查证优先级：免核**（机制性结论；重引入生成器时作废）

## 结论

2026-11-09 起本仓库**没有代码生成器**：`scripts/cli.ts`、`scripts/cli/`（package / client /
service / crud 四类模板及其 `.eta` 文件）与 `scripts/check-scaffold-templates.ts` 已删除，
根 `package.json` 的 `cli` / `check:scaffold` 脚本与 `eta` devDependency 一并移除。

因此：新模块 / 新工程一律照现有实现手写（`develop-business-module` 的 module-guide、user 全链路
范例），**不存在需要同步的「模板副本」**；后端守卫只剩 `check:inject` / `check:mastra`，
前端守卫 `check:ui` 为四条（组件导出 / `typecheck` 脚本 / 硬编码调色板 / 样式入口 + 字体规范）。

## 依据

```bash
ls scripts/                      # 只有 setup / kill-dev / check-* / codegraph-setup
node -e "console.log(require('./package.json').scripts)"   # 无 cli、check:scaffold
```

## 失效信号

`scripts/cli/` 再次出现（重新引入代码生成器）时，本卡作废。

## 备注

`eta` 仍是 `apps/server` 的运行时依赖（`modules/ai/core/prompts/prompt.engine.ts` 渲染提示词），
删的是根上的 devDependency，不影响 server。
