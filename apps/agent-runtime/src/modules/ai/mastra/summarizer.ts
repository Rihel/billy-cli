import { Agent } from '@mastra/core/agent'
import { decideModelForMastra } from '../core/model-decision.js'
import type { RuntimeModel } from '../core/envelope.js'

/** 一次压缩调用的原始结果（用量交给调用方并进这一轮的账） */
export interface CompressionRun {
  text: string | null
  usage: unknown
}

/**
 * 上下文压缩的模型调用（Mastra 适配层，设计 `docs/design/ai-agent.md` §3.9）。
 *
 * **必须隔离**：早先用的是当前会话的同一个 agent，它带着全部工具与技能 ——
 * 模型只要在这一步调了工具，`text` 就是空，摘要静默地不生成。
 * 这里照 `title` / 记忆抽取的做法：临时 agent，只有压缩指令，没有工具 / 技能 / 记忆。
 */
export const runContextCompression = async (input: {
  model: RuntimeModel
  instructions: string
  transcript: string
  maxOutputTokens: number
}): Promise<CompressionRun> => {
  const decision = decideModelForMastra(input.model)
  const agent = new Agent({
    id: 'context-compressor',
    name: '上下文压缩',
    instructions: input.instructions,
    model: decision.model,
  })
  const result = await agent.generate([{ role: 'user', content: input.transcript }] as never, {
    maxSteps: 1,
    modelSettings: { maxOutputTokens: input.maxOutputTokens },
  })
  return {
    text: (result.text as string | undefined) ?? null,
    usage: result.totalUsage ?? result.usage ?? null,
  }
}
