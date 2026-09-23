import { TOOL_KEYS } from '../tools/tool-keys.js'
import type { AgentSpec } from '../core/ai.types.js'

/**
 * 默认 agent：通用助手（可查、可写、能造子助手）。
 *
 * 「能做什么」由 `tools` 决定：这里授权了写工具 `create-todo`，
 * 所以提示词只需要交代「什么时候用」，不需要求模型自律。
 * 工具 key 从 `tool-keys.ts` 取（不写裸字符串，改名时编译期就报错）。
 *
 * `run-sub-agent` 是**委派类工具**：给出去之后，这个 agent 就能为一件事临时造一个专职子助手
 * （子助手的提示词由它现写、工具面是"全部 − 委派类"）——见设计文档 §3.14。
 * 子助手不是注册表成员，所以这里不需要声明任何"子 agent 名单"。
 */
export const assistantAgent: AgentSpec = {
  key: 'assistant',
  name: '通用助手',
  description: '日常问答 + 待办查询与新增（可写）+ 可为子任务临时创建子助手',
  tools: [
    TOOL_KEYS.listTodos,
    TOOL_KEYS.getTodo,
    TOOL_KEYS.createTodo,
    TOOL_KEYS.writePlan,
    TOOL_KEYS.runSubAgent,
  ],
  skills: ['todo-report'],
  prompt: { template: 'assistant' },
}
