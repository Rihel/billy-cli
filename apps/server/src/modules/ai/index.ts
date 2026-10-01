/**
 * AI 模块（Mastra）：接口 + 核心引擎 + 会话运行时 + agent 声明 + 具体工具 + 适配器。
 *
 * 目录约定（新增 AI 能力时的落点）：
 * - `api/`          接口层：`ai.controller`（对话路由）/ `ai-tool.controller`（工具配置路由）/
 *                   `ai-tool.service`（后台工具配置服务）；
 * - `core/`         核心引擎（与"具体是哪件事"无关）：`envelope`（运行时信封）/ `config` /
 *                   `constants` / `errors` / `model-decision`；外加
 *                   `core/tools/**`（**工具引擎**：DSL 装饰器 / 注册机 / 网关 / 插件 / 配置入库 / 分页取页）、
 *                   `core/skills/**`（`SkillLoader` + `catalog/<名字>/SKILL.md`）、
 *                   `core/prompts/**`（提示词引擎 + `templates/*.eta`）；
 * - `runtime/`      会话 / 运行 / 时间线 / 上下文 / 流记录 / 子 agent 执行器 / 崩溃恢复 +
 *                   `plan.protocol`（计划协议）；
 * - `agents/`       agent 声明（一个文件一个）+ `index.ts` 唯一登记处 + `types` / `registry` / `service`；
 * - `tools/`        具体工具（用 `core/tools` 的引擎写）：`command.tool` / `subagent.tool` /
 *                   `read-tool-result.tool` / `planner/**`（规划工具组）；
 * - `mastra/`       适配器（**唯一可 import `@mastra`**）：`ai.mastra` 装配 + tool / agent / context /
 *                   stream / skill 适配器。
 */
export * from './ai.module.js'
export * from './api/ai.controller.js'
export * from './agents/service.js'
export * from './mastra/ai.mastra.js'
export * from './agents/registry.js'
export * from './core/config.js'
export * from './core/constants.js'
export * from './core/errors.js'
export type { AgentDefinition, AgentSpec, AgentRegistry } from './agents/types.js'
export * from './runtime/index.js'
export * from './agents/index.js'
export * from './core/tools/index.js'
export * from './core/skills/index.js'
export * from './core/prompts/index.js'
export * from './tools/read-tool-result.tool.js'
