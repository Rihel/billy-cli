export * from './tools.types.js'
export * from './tool-keys.js'
export * from './tool.builder.js'
// 业务工具 bean（`*.tool.ts`）当前为空：AI 模块已与业务模块解耦。
// 新增业务工具时：写一个 `@Injectable()` bean + 在 `ai.module.ts` 的 `AGENT_TOOLS` 登记一行。
// 规划（todo-write）与子 agent（run-sub-agent）等**跨业务的运行时能力**不在本目录：
// 它们是 core bean（`ai/core/*.core.ts`，用 `asTools()` 交出工具），见 docs/design/ai-agent.md §3.14.1。
