import type { ToolsInput } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import type { RequestContext } from '@mastra/core/request-context'
import { paginate, serializeToolValue, toModelPage } from '../core/tools/paginate.js'
import { isPagedToolValue } from '../core/tools/tools.types.js'
import type { Tool, ToolLogger, Toolbox } from '../core/tools/tools.types.js'
import { readEnvelope } from './context.adapter.js'

/**
 * **我们的工具 → Mastra 工具**（适配器，设计 §5.8）：词汇映射只在这里做一次。
 *
 * | 我们 | Mastra |
 * | --- | --- |
 * | `key` | `createTool({ id })` |
 * | `params` | `inputSchema` |
 * | `run()` | `execute` |
 * | 统一结论 | 返回值 / 抛错（→ 模型看到的工具错误） |
 * | 分页视图 | `toModelOutput` |
 *
 * 两条与分页相关的口径（用例 ① 实测过）：
 * - 工具**照旧返回全量** ⇒ 流里有全量 ⇒ 时间线全量 ⇒ 前端全量；
 * - `toModelOutput` 只把"给模型的那一份"换成第一页 —— 于是"入参出参全量入库"这条硬规则不破。
 */

/** Mastra 工具执行上下文的最小面（只取我们用到的那几项，别把它的泛型铺满本文件） */
interface ToolExecutionContextLike {
  requestContext?: RequestContext
  abortSignal?: AbortSignal
  agent?: { toolCallId?: string }
  writer?: { write(chunk: unknown): Promise<unknown> | unknown }
}

/** 给模型的默认视图（与 AI SDK 的 `createToolModelOutput` 同形：字符串走 text，其余走 json） */
const defaultModelOutput = (output: unknown): unknown =>
  typeof output === 'string'
    ? { type: 'text', value: output }
    : { type: 'json', value: output ?? null }

/** 分页后给模型的第一页视图（用同一个纯函数重算，保证与执行时那一次逐字节一致） */
const pagedModelOutput = (data: unknown, pageSize: number, handle: string): unknown => {
  const page = paginate(serializeToolValue(data), pageSize, 1, handle)
  return { type: 'json', value: toModelPage(page) }
}

/** 工具拒绝 / 失败：抛出去让 Mastra 落成 `tool-output-error`（模型看到 message，继续下一轮） */
export class ToolOutcomeError extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly hint?: string,
  ) {
    super(hint ? `${message}（${hint}）` : message)
    this.name = 'ToolOutcomeError'
    // 工具失败结论只保留原因与提示；堆栈留给服务端日志，不要带到模型/前端
    this.stack = undefined
  }
}

/** 单个工具 */
export const toMastraTool = (tool: Tool, logger: ToolLogger): ToolsInput[string] =>
  createTool({
    id: tool.key,
    description: tool.spec.description,
    // 给模型的是**含必填 reason** 的那一份（引擎注入，见 `core/tools/call-reason.ts`）：
    // 模型据此知道每次调用都要说明"为什么用它"，Mastra 也按它校验
    inputSchema: tool.spec.modelParams ?? tool.spec.params,
    execute: async (input: unknown, context: unknown) => {
      const runtime = context as ToolExecutionContextLike
      const envelope = readEnvelope(runtime?.requestContext)
      const outcome = await tool.run(input, {
        callId: runtime?.agent?.toolCallId ?? null,
        envelope,
        log: logger,
        ...(runtime?.abortSignal ? { signal: runtime.abortSignal } : {}),
        ...(runtime?.writer ? { writer: runtime.writer } : {}),
      })
      if (outcome.ok) return outcome.data
      throw new ToolOutcomeError(outcome.reason, outcome.message, outcome.hint)
    },
    /**
     * 分页只改"给模型的那一份"：全量在返回值里（→ 时间线）。
     *
     * durable 与不 durable 都以 `toModelOutput(result)` 单参调用（用例 ①/② 实测），
     * 所以这里只认输出本身、不依赖任何上下文。
     */
    toModelOutput: (output: unknown) => {
      if (!isPagedToolValue(output)) return defaultModelOutput(output)
      return pagedModelOutput(output.data, output.page.pageSize, output.page.handle)
    },
  }) as ToolsInput[string]

/** 一整箱工具（主 agent 与子 agent 共用） */
export const toMastraTools = (toolbox: Toolbox, logger: ToolLogger): ToolsInput => {
  const tools: ToolsInput = {}
  for (const [key, tool] of toolbox) tools[key] = toMastraTool(tool, logger)
  return tools
}
