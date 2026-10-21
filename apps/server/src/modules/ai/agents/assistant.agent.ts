import { TOOL_KEYS } from '../core/tools/tool-keys.js'
import type { AgentSpec } from './types.js'

/**
 * 默认 agent：通用助手（会写任务清单、能造子助手、能联网、能执行命令）。
 *
 * 「能做什么」由 `tools` 决定：这里只授权**运行时能力**——规划一组四个工具
 * （`plan-create` / `plan-reorder` / `plan-complete` / `plan-delete`）、
 * `run-sub-agent`（子 agent）、`run-command`（执行命令行命令）、
 * `web-fetch` / `web-request` / `web-search`（联网）。AI 模块已与业务模块解耦，
 * 没有绑定任何业务工具，所以提示词只需要交代"什么时候用"，不需要（也不允许）点名不存在的业务工具。
 * 工具 key 从 `tool-keys.ts` 取（不写裸字符串，改名时编译期就报错）。
 *
 * `run-sub-agent` 是**委派类工具**：给出去之后，这个 agent 就能为一件事临时造一个专职子助手
 * （子助手的提示词由它现写、工具面是"全部 − 委派类"）——见设计文档 §3.14。
 * 子助手不是注册表成员，所以这里不需要声明任何"子 agent 名单"。
 *
 * `run-command` 是**跨平台命令执行**（Windows `cmd.exe` / POSIX `/bin/sh`，底层 execa）：
 * 开关与边界（默认工作目录 / 时长 / 输出上限）由 `agent.command*` 配置收口，见 §3.15。
 * **默认关闭**（`AGENT_COMMAND_ENABLED=false`）：它不是沙箱，命令以服务进程权限执行、
 * 能读写该身份能读写的一切；自用 / 内网确需时才显式打开。它**不是**委派类工具，
 * 所以打开时子助手也拿得到（"有你的全部工具"这条口径不变）。
 *
 * `web-fetch` / `web-request` / `web-search` 是**联网三件套**：**优先直取** —— 有 URL 就用
 * `web-fetch` 读正文、有接口地址就用 `web-request` 调；只有确实不知道来源时才用 `web-search`
 * 找候选，拿到 URL 后仍回到 `web-fetch`。三者共用统一出网预算与内网拦截，
 * 抓取与请求还按 1000 行一页返回、带 `ref` 续读（见 `tools/web.tools.ts` 的类注释）。
 */
export const assistantAgent: AgentSpec = {
  key: 'assistant',
  name: '通用助手',
  description:
    '日常问答 + 任务清单（创建 / 重排 / 完成 / 删除）+ 联网查资料（搜索 / 抓网页 / 调接口）+ 可临时创建子助手 + 可执行本机命令（默认关闭，仅自用部署显式开启）',
  tools: [
    TOOL_KEYS.planCreate,
    TOOL_KEYS.planReorder,
    TOOL_KEYS.planComplete,
    TOOL_KEYS.planDelete,
    TOOL_KEYS.runSubAgent,
    TOOL_KEYS.runCommand,
    // 联网：默认先直取（有 URL / 接口），搜索只作兜底 —— 顺序也按这个优先级排
    TOOL_KEYS.webFetch,
    TOOL_KEYS.webRequest,
    TOOL_KEYS.webSearch,
  ],
  skills: ['todo-report'],
  prompt: { template: 'assistant' },
}
