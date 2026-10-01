/**
 * AI 模块（Mastra）：多 agent 注册表 + 提示词模板引擎 + 工具引擎 + 技能加载器 + 会话运行时。
 *
 * 目录约定（新增 AI 能力时的落点）：
 * - `core/`        机制层（与具体 agent 无关）：领域原语 `ai.types` / `ai.core.types` / `ai.errors` /
 *                  `ai.constants` / `ai.model-decision`，配置 `ai.config`，注册表 `ai.registry` 与
 *                  装配查询服务 `ai.service`；
 * - `core/beans/`  **工具类**（与业务无关的运行时能力，一个工具一个 `@Injectable()` 类）：
 *                  `command.tool` / `subagent.tool` /
 *                  `planner/`（四个规划工具类 + `plan.protocol` 计划协议）；
 * - `agents/`      每个 agent 一个声明文件 + `index.ts` 唯一登记处；
 * - `tools/`       工具主体（**禁 import `@mastra`**）：DSL / 注册机 / 网关 / 插件 / 配置入库 / 分页取页，
 *                  以及后台工具配置服务 `ai-tool.service`；
 * - `mastra/`      适配器（**唯一可 import `@mastra`**）：`ai.mastra` 装配 + tool / agent / context /
 *                  stream / skill 适配器；
 * - `runtime/`     会话 / 运行 / 时间线 / 上下文 / 流记录 / 子 agent 执行器 / 崩溃恢复；
 * - `prompts/`     提示词引擎 + `templates/*.eta` 模板（含 `partials/`）；
 * - `skills/`      `SkillLoader`（加载 + 校验）+ `catalog/<名字>/SKILL.md` 技能内容。
 */
export * from './ai.module.js'
export * from './ai.controller.js'
export * from './core/ai.service.js'
export * from './mastra/ai.mastra.js'
export * from './core/ai.registry.js'
export * from './core/ai.config.js'
export * from './core/ai.constants.js'
export * from './core/ai.errors.js'
export type { AgentDefinition, AgentSpec, AgentRegistry } from './core/ai.types.js'
export * from './runtime/index.js'
export * from './agents/index.js'
export * from './tools/index.js'
export * from './skills/index.js'
export * from './prompts/index.js'
