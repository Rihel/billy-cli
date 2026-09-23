# AI 扩展点：加 agent / 工具 / core bean / 技能 / 子 agent

> 本文件是 `develop-ai-agent` skill 的组成部分。设计依据见 `docs/design/ai-agent.md` §1、§3.14。

## 1. 加一个业务工具（`ai/tools/*.tool.ts`）

适用：某个**业务模块**的操作（查 / 建 / 改）。三步：

1. 在 `tools/tool-keys.ts` 的 `TOOL_KEYS` 加一个 key（**不写裸字符串**：写错 key 是编译期错误）；
2. 写 `@Injectable()` 类实现 `AgentTool`（`key` / `title` / `description` / `tool: createTool({ id, description, inputSchema, execute })`），
   构造器注入业务 service —— 与业务接口同一条链路；
3. 在 `ai.module.ts` 的 `AGENT_TOOLS` 多 provider 里登记一行，并在需要的 agent 声明里授权该 key。

入参契约用 zod 写**给模型看的说明**（`.describe()`）；execute 只做校验与业务调用，
**出参原样返回、不裁剪**（运行时会把完整出参落时间线）。

## 2. 加一个 core bean（`ai/core/*.core.ts`）

适用：**跨业务的运行时能力**（规划、子 agent、将来的检索 / 记忆 / 工具编排）。
判断标准是依赖方向：要碰会话 / 运行记录 / 编排层的，就是 core bean。

```ts
@Injectable()
export class XxxCore implements AgentCore {
  readonly key = 'xxx'
  asTools(): readonly AgentTool[] { return [this.tool] }
}
```

- 在 `ai.module.ts` 的 `AGENT_CORES` 登记（与 `AGENT_TOOLS` 同一手法汇总）；
- **不要注入 `ToolBuilder`**（它会依赖 core bean → 成环）：需要"全部工具"之类的信息，
  让编排层算好、经 `requestContext` 的**运行时信封**传进来（见下）；
- 委派类工具标 `delegation: true` —— 子 agent 的工具面 = 全部 − 委派类。

## 3. 运行时信封（工具怎么知道"我在哪一轮"）

编排层（`AgentChatService.buildRuntimeContext`）在发起一轮时把信封塞进 Mastra `requestContext`：
`{ conversationId, parentRunId, triggeredBy, depth, childTools, childSkills, abortSignal }`。

工具侧只读四样（都在 `ToolExecutionContext` 上，已核实）：
`requestContext`（信封）/ `agent.toolCallId`（幂等键）/ `writer`（写 `data-*` 到父流）/ `abortSignal`（停止传播）。

## 4. 加一个顶层 agent（`ai/agents/*.agent.ts`）

1. 一个声明文件（`AgentSpec`：key / name / description / tools / skills / prompt）；
2. 在 `agents/index.ts` 的 `AGENT_SPECS` 加一行；
3. 加 `prompts/templates/<模板>.eta`。**所有提示词只走引擎**：`{{= }}` 插值、`{{~ include('partials/x') }}` 复用，
   "可用工具"那段由 `toolBuilder.describe(spec.tools)` 渲染 —— 提示词里的工具清单与实际挂载的**同源**，
   key 写错在启动期就报错。

## 5. 加一个技能（`skills/catalog/<name>/SKILL.md`）

目录 + `SKILL.md`（+ 可选 `references/`），然后在 agent 声明的 `skills` 里授权；
`SkillLoader` 会在启动期校验并解析成 Mastra 的 `InlineSkill`（未知名直接启动失败）。

## 6. 子 agent（动态创建，不是静态声明）

- 子 agent **不在注册表里**：主 agent 调用 `run-sub-agent` 工具，运行期现场创建（跑完即弃）；
- 入参三件套：`name` / **`system_prompt`（主 agent 现写，必填）** / `task`；
- 工具面 = **全部 − 委派类**（所以子 agent 不能再造子 agent，深度天然为 1）；
- 明细全部入库：独立 `runs` 行（`parent_run_id` / `depth` / `tool_call_id`）+ 自己完整的 `timelines`，
  动态提示词与任务全量落 `request_snapshot`；
- **父的 `usage` 汇总子的消耗**（`usage.subAgents`），但 `step_count` / `tool_call_count` 各记自己的；
  轮数只数根 run；
- 配额：`subAgentMaxPerRun`（默认 4）/ `subAgentMaxDepth`（1）/ `subAgentMaxSteps` / `subAgentTimeoutMs`；
  超限**不抛异常炸整轮**，把原因作为工具结论返回给模型；
- 幂等：同一 `(parent_run_id, tool_call_id)` 已成功过 → 复用上次结论（不重跑、不重复扣费）。

## 7. 契约、SDK 与前端

- 契约加在 `packages/shared/src/schema/agent.schema.ts`，**改完必须 `pnpm build:pkgs`**；
- SDK 的 typed 方法在 `packages/sdk/src/server.client.ts` 的 `agent` 分组（含 `chatStreamUrl` /
  `resumeStreamUrl` / `authHeaders` 三个给 AI SDK 用的旁路）；
- 前端页面：web `apps/web/src/app/ai/chat`（useChat + ai-elements，渲染每个 part），
  审计页 admin `apps/admin/src/app/main/ai/audit`（会话 → 运行树 → 时间线 + 输入快照）。
