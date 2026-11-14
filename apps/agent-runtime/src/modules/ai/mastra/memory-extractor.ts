import { Agent } from '@mastra/core/agent'
import { decideModelForMastra } from '../core/model-decision.js'
import type { RuntimeModel } from '../core/envelope.js'

/** 一次抽取调用的原始结果（用量由调用方并账） */
export interface MemoryExtractionRun {
  text: string | null
  usage: unknown
}

/**
 * 记忆抽取的模型调用（Mastra 适配层，设计 `docs/design/ai-memory.md` §5.6）。
 *
 * 与 `title.service` 同一手法：**现场造一个隔离的临时 agent** ——
 * 只有抽取指令，没有工具 / 技能 / 记忆 / 运行时信封；
 * 它看不到会话系统提示词，也拿不到任何工具，只做"对话 → JSON"这一件事。
 */
export const runMemoryExtraction = async (input: {
  model: RuntimeModel
  instructions: string
  transcript: string
  timeoutMs: number
  maxOutputTokens: number
}): Promise<MemoryExtractionRun> => {
  const decision = decideModelForMastra(input.model)
  const agent = new Agent({
    id: 'memory-extractor',
    name: '记忆抽取',
    instructions: input.instructions,
    model: decision.model,
  })
  const result = await agent.generate([{ role: 'user', content: input.transcript }] as never, {
    maxSteps: 1,
    modelSettings: { maxOutputTokens: input.maxOutputTokens },
    abortSignal: AbortSignal.timeout(input.timeoutMs),
  })
  return {
    text: (result.text as string | undefined) ?? null,
    usage: result.totalUsage ?? result.usage ?? null,
  }
}
