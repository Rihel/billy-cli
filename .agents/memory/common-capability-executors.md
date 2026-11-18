# common-capability 执行器：装饰器声明 + 扫描绑定（一个进程一个服务）

> **查证优先级：必核** —— 能力数 / 声明与方法对应 / 任务形态；加能力或改注册后重核。

## 结论（2026-11-18，装饰器口径）

- **一个执行器类 = 一个能力组，类内一个 `@CapabilityDecl` 方法 = 一个能力**（与 runtime 的
  `@ToolGroup` / `@ToolDecl` 同形）。入参 zod 内联在声明里，执行体用
  `findCapabilityDecl(this, '<tool>').input.safeParse` 校准入参 —— 与登记同一份，不会漂移。
- `ToolExecutorRegistry` 构造时对 7 个执行器实例 `scanCapabilities`，把声明绑成
  `ToolExecutor { key, execute }`；`tools()` / `definitions()` / `isTaskTool()` 都从绑定结果来，不再手抄 key 列表。
- 能力总数 **17**：bash 1 + web 3 + file 9 + read-tool-result 1 + memory 3；只有 `bash` 是
  `execution.mode='task'`（`/invoke` 先受理再 `tasks/get|cancel`）。
- 文件域 9 个 schema 仍来自 `@repo/ai-data`（与 server 单一来源，不内联）；bash / web / memory /
  read-tool-result 的入参已内联进各自声明，独立 `capabilities/schemas.ts` 已删。
- file / memory 的 `execute(key, …)` 大 switch 拆成「一能力一方法 + 私有公共执行体」（`run(tool, request)`）。
- 登记只有一个服务身份 `common`（manifest 的 `buildCommonService`），其余都是代码内分组。

## 关键位置

| 位置 | 内容 |
| --- | --- |
| `packages/capability/src/decorator.ts` | 装饰器与扫描（机制） |
| `apps/common-capability/src/executors/executor.registry.ts` | 扫描绑定 / 分发 / 任务形态 |
| `apps/common-capability/src/executors/bash.executor.ts` | bash（task 形态模板） |
| `apps/common-capability/src/tools/web/*.executor.ts` | web-fetch / web-search / web-request |
| `apps/common-capability/src/tools/file/file.executor.ts` | file-*（9 个方法 + 私有 run） |
| `apps/common-capability/src/tools/memory/memory.executor.ts` | memory-*（3 个方法 + 私有 run） |
| `apps/common-capability/src/tools/read-tool-result.executor.ts` | 取页（Redis + PG timeline） |
| `packages/web-runtime` | 出网 / Markdown / 分页 / 反爬（server + worker 共用） |

## 核对命令

```bash
grep -rn "@CapabilityDecl(" apps/common-capability/src | wc -l      # 17
grep -n "isTaskTool\|scanCapabilities" apps/common-capability/src/executors/executor.registry.ts
grep -rn "capabilities/schemas" apps/common-capability/src || echo "schemas.ts 已删"
pnpm --filter @app/common-capability test                            # 30 条
```

## 失效信号

执行器又重新手写 `key` / 手工维护工具清单 / 入参与登记各写一份 / 出现 `capabilities/schemas.ts`；
任一出现都要回来改卡片。
