/**
 * 引擎能力接缝的 DI token。
 *
 * 用 Symbol 而不是字符串：拼错会静默注入 undefined（tsx 不产出 design:paramtypes），
 * 同名的 Symbol 在模块间共享，typo 会变成编译错误。
 */
export const TOOL_FACE = Symbol.for('ai.engine.ToolFace')
export const CONTEXT_ASSEMBLER = Symbol.for('ai.engine.ContextAssembler')
export const MEMORY_PORT = Symbol.for('ai.engine.MemoryPort')
export const STREAM_PUBLISHER = Symbol.for('ai.engine.StreamPublisher')
export const RUN_RECORDER_FACTORY = Symbol.for('ai.engine.RunRecorderFactory')
export const WORKSPACE_FILES = Symbol.for('ai.engine.WorkspaceFiles')
export const WORKSPACE_EXEC = Symbol.for('ai.engine.WorkspaceExec')
export const APPROVAL_PORT = Symbol.for('ai.engine.ApprovalPort')
export const AGENT_LOOP = Symbol.for('ai.engine.AgentLoop')
