# 能力执行器：装饰器声明 + 扫描绑定（一个进程一个服务）

> **查证优先级：必核** —— 能力数 / 声明与方法对应 / 任务形态；加能力或改注册后重核。

## 结论（2026-11-20，工作区执行面接入后）

- **一个执行器类 = 一个能力组，类内一个 `@CapabilityDecl` 方法 = 一个能力**（与 runtime 的
  `@ToolGroup` / `@ToolDecl` 同形）。入参 zod 内联在声明里，执行体用
  `findCapabilityDecl(this, '<tool>').input.safeParse` 校准入参 —— 与登记同一份，不会漂移。
- 两个进程各登记**一个服务身份**：
  - `common-capability` → `common`：声明 **17** 个（bash 1 + web 3 + file 9 + read-tool-result 1 +
    memory 3），manifest 按 `decl.execution?.where === 'workspace'` 过滤掉 bash 与 7 个工作区文件，
    **实际登记 9 个**（web 3 / memory 3 / read-tool-result 1 / file-submit + file-download 2），全是 sync；
  - `workspace-service` → `workspace`：**8 个**（`bash` 1 + 工作区文件 7 个）；只有 `bash` 是
    `execution.mode='task'`（`/invoke` 先受理再 `tasks/get|cancel`），文件能力全是 sync。
- 合计 **20 个 code 能力**；网关内建 `wait-task` / `cancel-task` / `tool-search` 不登记给任何服务。
- 文件域 schema 仍来自 `@repo/ai-data`（与 server 单一来源，不内联）；common 的 bash / 7 个工作区文件
  声明作为执行体模板保留，但**不登记**（跨服务重名 409）。
- 登记器 `CapabilityRegistrar`：启动 register → 10s 心跳 → 停机 deregister；`TOOL_WORKER_ID` /
  `TOOL_WORKER_ENDPOINT` 按 Pod 维度自报。

## 关键位置

| 位置 | 内容 |
| --- | --- |
| `packages/capability/src/decorator.ts` | 装饰器与扫描（机制） |
| `packages/capability/src/registrar.ts` | 登记 / 心跳 / 注销生命周期 |
| `apps/common-capability/src/capabilities/manifest.ts` | `common` 服务清单（过滤 `where='workspace'`） |
| `apps/common-capability/src/executors/executor.registry.ts` | 扫描绑定 / 分发 |
| `apps/common-capability/src/tools/web/*.executor.ts` | web-fetch / web-search / web-request |
| `apps/common-capability/src/tools/file/file.executor.ts` | file-*（9 个方法；工作区 7 个被过滤） |
| `apps/common-capability/src/tools/memory/memory.executor.ts` | memory-*（3 个方法） |
| `apps/workspace-service/src/capabilities/bash.executor.ts` | bash（task 形态，经工作区执行） |
| `apps/workspace-service/src/capabilities/file.executor.ts` | 工作区文件 7 个 |
| `packages/web-runtime` | 出网 / Markdown / 分页 / 反爬（server + common 共用） |

## 核对命令

```bash
grep -rn "@CapabilityDecl(" apps/common-capability/src | wc -l   # 17 声明（登记 9）
grep -rn "@CapabilityDecl(" apps/workspace-service/src | wc -l   # 8（含 bash task）
grep -c "@CapabilityDecl(" apps/capability-gateway/src/registry/builtin.capabilities.ts  # 3
grep -n "execution.where\|execution?.where\|where !== 'workspace'" apps/common-capability/src/capabilities/manifest.ts
grep -n "isTaskTool\|scanCapabilities" apps/common-capability/src/executors/executor.registry.ts
pnpm --filter @app/common-capability test
pnpm --filter @app/workspace-service test
```

## 失效信号

执行器又重新手写 `key` / 手工维护工具清单 / 入参与登记各写一份 / 出现 `capabilities/schemas.ts`；
bash 或工作区文件能力重新登记到 `common`；任一出现都要回来改卡片。
