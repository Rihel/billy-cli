# agent 工具授权：选择器 / 装配期过滤 / 子 agent 上限

**查证优先级：必核** —— 选择器语法与过滤位置随工具引擎改动漂移；动 agent 授权前先跑下面的命令。

## 结论（2026-11-10）

- `AgentSpec.tools` 是**结构化选择器**数组：字符串 = 具体 key 或 `'*'`；对象 =
  `{ category }` 或 `{ connector, tool? }`。定义在 `core/tools/tool-selector.ts`，**没有字符串解析器**。
- 展开只在一处：`ToolRegistry.expand(selectors)`。具体 key 不存在 → 装配期 `describe()` 抛；
  连接器选择器**允许零命中**（连接器运行期才同步）。
- 作用域**装配期就过滤工具面**：`ai.module.ts` 的 `resolveTools(ids, caller)` →
  `ToolRegistry.authorized(keys, caller)`；`ScopePlugin` 只兜调用期。判据纯函数在 `tool.scope.ts`。
- 子 agent 工具面 = **父授权 ∩（全部 − 委派类 − `child: deny`）**：
  `chat.service.ts` 的 `buildRuntimeContext` 传 `definition.tools` 进 `childToolbox(parentTools)`。
- 快照里的 `toolKeys` 是**展开后的具体 key**（`this.toolRegistry.expand(...)`），不是选择器。

## 依据 / 核对命令

```bash
grep -n "expandToolSelectors\|authorized(" apps/server/src/modules/ai/core/tools/tool.registry.ts
grep -n "resolveTools:" -A 5 apps/server/src/modules/ai/ai.module.ts
grep -n "childToolbox(" apps/server/src/modules/ai/runtime/chat.service.ts
grep -n "scopeAllows" apps/server/src/modules/ai/core/tools/tool.scope.ts
pnpm --filter @app/server test test/ai-tool-selector.test.ts
```

## 失效信号

- 选择器改成字符串语法 / 引入 glob；
- 装配期过滤被挪回调用期（`ScopePlugin` 之外又出现"工具先给、调用再拒"）；
- 子 agent 工具面又变回注册机全量（授权被绕过）。
