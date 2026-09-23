/**
 * AI 模块（Mastra）：多 agent 注册表 + 提示词模板引擎 + 工具池 + 技能加载器。
 *
 * 目录约定（新增 AI 能力时的落点）：
 * - `core/`    机制层：配置 / 注册表 / Mastra 装配 / 装配查询服务 / 错误（与具体 agent 无关）
 * - `agents/`  每个 agent 一个声明文件 + `index.ts` 唯一登记处
 * - `tools/`   工具 key 常量 + **一个工具一个 bean** + `ToolBuilder`（统一管理）
 * - `prompts/` 提示词引擎 + `templates/*.eta` 模板
 * - `skills/`  `SkillLoader`（加载 + 校验）+ `catalog/<名字>/SKILL.md` 技能内容
 */
export * from './ai.module.js'
export * from './ai.controller.js'
export * from './core/ai.service.js'
export * from './core/ai.mastra.js'
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
