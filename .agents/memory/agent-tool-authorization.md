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

## 坑：身份没进运行时信封 = admin 工具整组消失（2026-11-11 实测）

- `buildRuntimeContext` 的 `isAdmin` 必须由 `chat` / `chatStream` / `resumeChat` **显式传入**
  （`buildRuntimeContext` 里 `options.isAdmin ?? false`）。
- 漏传时信封 `isAdmin=false`：`authorized()` 会把**所有 `scope='admin'` 的工具**从模型工具面过滤掉，
  但**提示词与 `request_snapshot.toolKeys` 仍然列着它们** —— 表现是"模型说工具清单里有、实际没有"，
  于是绕 `run-command` 写文件（实际踩过：全部 `skill-*` 被过滤，技能被写到 `~/.agents/skills`，不入库）。
- 核对：`grep -n "buildRuntimeContext(" -A 12 apps/server/src/modules/ai/runtime/chat.service.ts`，
  三个主路径（chat / chatStream / resumeChat）的 options 都要有 `isAdmin`。

## 依据 / 核对命令

```bash
grep -n "expandToolSelectors\|authorized(" apps/server/src/modules/ai/core/tools/tool.registry.ts
grep -n "resolveTools:" -A 5 apps/server/src/modules/ai/ai.module.ts
grep -n "childToolbox(" -A3 apps/server/src/modules/ai/runtime/chat.service.ts
grep -n "buildRuntimeContext(" -A12 apps/server/src/modules/ai/runtime/chat.service.ts
grep -n "scopeAllows" apps/server/src/modules/ai/core/tools/tool.scope.ts
pnpm --filter @app/server test test/ai-tool-selector.test.ts
```

## 失效信号

- 选择器改成字符串语法 / 引入 glob；
- 装配期过滤被挪回调用期（`ScopePlugin` 之外又出现"工具先给、调用再拒"）；
- 子 agent 工具面又变回注册机全量（授权被绕过）。
