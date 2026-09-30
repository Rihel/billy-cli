import { TOOL_KEYS } from '../tools/tool-keys.js'
import type { AgentSpec } from '../core/ai.types.js'

/**
 * 默认 agent：通用助手（会写任务清单、能造子助手）。
 *
 * 「能做什么」由 `tools` 决定：这里只授权**运行时能力**——`todo-write`（任务清单）
 * 与 `run-sub-agent`（子 agent）。AI 模块已与业务模块解耦，没有绑定任何业务工具，
 * 所以提示词只需要交代"什么时候用"，不需要（也不允许）点名不存在的业务工具。
 * 工具 key 从 `tool-keys.ts` 取（不写裸字符串，改名时编译期就报错）。
 *
 * `run-sub-agent` 是**委派类工具**：给出去之后，这个 agent 就能为一件事临时造一个专职子助手
 * （子助手的提示词由它现写、工具面是"全部 − 委派类"）——见设计文档 §3.14。
 * 子助手不是注册表成员，所以这里不需要声明任何"子 agent 名单"。
 */
export const assistantAgent: AgentSpec = {
  key: 'assistant',
  name: '通用助手',
  description: '日常问答 + 多步任务的任务清单跟踪（todo-write）+ 可为子任务临时创建子助手',
  tools: [TOOL_KEYS.todoWrite, TOOL_KEYS.runSubAgent],
  skills: ['todo-report'],
  prompt: { template: 'assistant' },
}
