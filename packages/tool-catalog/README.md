# @repo/tool-catalog

**工具定义唯一来源**：key / 标题 / 描述 / 参数 Zod / 分类 / scope / executor / 版本。

server 的 `@ToolDecl` 与 tool-gateway 的 `/v1/tools/list` 都从这里取，避免“代码声明一份、网关 manifest 又手写一份”。

## 两种定义

- **worker / 已迁工具**：`BASH_TOOL` / `WEB_FETCH_TOOL` 手写在这里，server `@ToolDecl` 与 gateway 共用。
- **全量工具清单**：`ALL_TOOL_MANIFESTS` 由 `pnpm gen:tool-catalog` 从 server 的 `@ToolDecl`
  生成（含 file / skill / memory / planner / subagent 等）；改工具声明后必须重跑，否则 gateway
  的 `/v1/tools/list` 会旧。

## 导出

```ts
import {
  TOOL_DEFINITIONS,
  getToolDefinition,
  toToolManifest,
  BASH_TOOL,
  WEB_FETCH_TOOL,
  ALL_TOOL_MANIFESTS,
} from '@repo/tool-catalog'
```

- `TOOL_DEFINITIONS`：全部工具定义（新增工具加在这里）
- `getToolDefinition(key)`：按 key 取定义（gateway 策略校验用）
- `toToolManifest(definition)`：转成给模型 / 调用方的 manifest；自动补必填 `reason`

## 新增工具

1. 在 `src/tools/<key>.ts` 定义 `params`（Zod）+ `description` + scope / executor；
2. 加进 `TOOL_DEFINITIONS`；
3. server 的 `@ToolDecl` 引 `params/title/description`；
4. worker 写 `ToolExecutor` 并注册；
5. gateway 不用改 —— 跑 `pnpm gen:tool-catalog` 后自动出现在 `/v1/tools/list`；
6. **生成物必须和声明一起提交**：`pnpm check:tool-catalog`（已接进 `pnpm verify` 与 pre-push）
   会在两者不一致时直接失败。这正是 2026-11-15 `wait-sub-agent` 三个工具「后台在册、模型调不到」
   的原因 —— 声明加了，`generated.ts` 没重生成。
7. 本包被 gateway 以 `dist/index.mjs` 消费：改完 `generated.ts` 后跑
   `pnpm --filter @repo/tool-catalog build`（或 `pnpm dev:pkgs` 常驻构建），再重启 gateway 才生效。
