import { Inject, Injectable } from '@nestjs/common'
import { Agent } from '@mastra/core/agent'
import { AppLogger } from '@repo/kits'
import { TimelineKind, TimelineRole } from '@repo/shared'
import { decideModelForMastra } from '../core/ai.model-decision.js'
import type { RuntimeModel } from '../core/ai.core.types.js'
import { PROMPT_ENGINE, type PromptEngine } from '../prompts/prompt.engine.js'
import { TimelineRepository } from './timeline.repository.js'
import { toUsageRecord } from './usage.js'

/** 自动会话名的字符上限（用户口径：**10 个字符内**） */
export const TITLE_MAX_CHARS = 10

/** 这次命名调用的墙钟上限（ms）：起名是"锦上添花"，不能因为模型慢把一轮问答拖住 */
const TITLE_TIMEOUT_MS = 10_000

/** 输出长度上限：名字最多 10 字，给 32 token 足够（顺带避免模型长篇推理） */
const TITLE_MAX_OUTPUT_TOKENS = 32

/** 送进模型的对话记录上限（字符）：命名只需要"这段对话在做什么"，不需要全文 */
const TRANSCRIPT_MAX_CHARS = 2_000

/** 一次命名调用的结果（`usage` 交给调用方并进那一轮的账） */
export interface FirstTurnTitle {
  title: string
  usage: Record<string, unknown> | null
}

/**
 * 把模型输出**收拾成一个能直接用的标题**；收拾不出东西就返回 null（调用方保住兜底标题）。
 *
 * 五步都是"模型不听话时的真实形态"逼出来的：
 * 1. 只取**第一行**（模型常先给一行名字再补解释）；
 * 2. 去掉行首的 `#` / `*` / `-` / 序号等 Markdown 痕迹；
 * 3. 去掉成对的引号 / 书名号 / 方括号（"只输出名字"它经常做不到）；
 * 4. 去掉结尾标点（`。` / `，` / `.`）；前三步**剥两层**（`**「x」**` 这种套两层包裹的很常见）；
 * 5. 按**码点**截到 10 个字符（`Array.from` —— 用 `slice` 会把 emoji / 生僻字切成半个）。
 */
const stripEdges = (value: string): string =>
  value
    // 行首的 Markdown 痕迹、序号（`#` `*` `-` `>` `1.` `1、`）与左半边包裹（`「` `《` `(`）
    .replace(/^["'“”‘’「」『』《》〈〉【】[\]()（）*_#`~\s\d.、>\-]+/, '')
    // 行尾的包裹符号与强调符（引号 / 书名号 / 方括号 / `**`），去掉一层
    .replace(/["'“”‘’「」『』《》〈〉【】[\]()（）*_#`~]+$/, '')
    // 结尾标点
    .replace(/[。，、；：.!?;:,]+$/, '')
    .trim()

export const sanitizeTitle = (raw: string | null | undefined): string | null => {
  if (!raw) return null
  const firstLine =
    raw
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  const stripped = stripEdges(stripEdges(firstLine))
  if (!stripped) return null
  const title = Array.from(stripped).slice(0, TITLE_MAX_CHARS).join('')
  return title || null
}

/**
 * **首轮会话命名**：把这一轮的对话记录交给模型，换回一个 ≤10 字的会话名。
 *
 * 三条硬要求（用户口径 + 工程口径）：
 * 1. **与当前 agent 上下文完全隔离**：这里**不用** Mastra 实例上那个 agent，而是现场造一个
 *    只有"命名指令"、**没有工具 / 技能 / 记忆 / 运行时信封**的临时 agent ——
 *    它看不到会话系统提示词，也拿不到任何工具，只有"记录 → 名字"这一件事；
 * 2. **只读这一轮的记录**：只取该 run 的用户 / 助手文本（工具入参出参与推理过程对命名是噪声），
 *    并按字符数封顶；
 * 3. **失败不影响这一轮**：超时 / 模型报错 / 输出收拾不出名字 → 返回 null，调用方保留兜底标题。
 *
 * 模型仍用**这一轮实际使用的那个**（管理员配的）—— 换一个"便宜的模型"就多一份配置与授权面，
 * 而这一次调用只要几十个 token。
 */
@Injectable()
export class AgentTitleService {
  constructor(
    @Inject(TimelineRepository) private readonly timelines: TimelineRepository,
    @Inject(PROMPT_ENGINE) private readonly prompts: PromptEngine,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async generateFirstTurnTitle(input: {
    conversationId: string
    runId: string
    model: RuntimeModel
  }): Promise<FirstTurnTitle | null> {
    const transcript = await this.readTranscript(input.conversationId, input.runId)
    if (!transcript) return null

    const startedAt = Date.now()
    try {
      const decision = decideModelForMastra(input.model)
      // 隔离就体现在这一行：临时 agent，自己的指令、没有工具 / 技能 / 记忆，也没有 requestContext
      const agent = new Agent({
        id: 'conversation-title',
        name: '会话命名',
        instructions: this.prompts.renderPartial('title', { maxChars: TITLE_MAX_CHARS }),
        model: decision.model,
      })
      const result = await agent.generate([{ role: 'user', content: transcript }] as never, {
        maxSteps: 1,
        modelSettings: { maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS },
        abortSignal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
      })
      const title = sanitizeTitle(result.text as string | undefined)
      const usage = toUsageRecord(result.totalUsage ?? result.usage ?? null)
      if (!title) {
        this.logger.warn('ai.conversation.title_empty', {
          conversationId: input.conversationId,
          runId: input.runId,
        })
        return null
      }
      this.logger.log('ai.conversation.title_generated', {
        conversationId: input.conversationId,
        runId: input.runId,
        title,
        durationMs: Date.now() - startedAt,
      })
      return { title, usage }
    } catch (error) {
      // 起名失败不能影响这一轮：记一条 warn，调用方保住"首条消息"那版标题
      this.logger.warn('ai.conversation.title_failed', {
        conversationId: input.conversationId,
        runId: input.runId,
        reason: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  /**
   * 该轮的对话记录（用户 / 助手文本，按 seq 顺序）。
   *
   * 只取这一轮的**根 run**：子 agent 的明细与工具往返对命名是噪声；
   * 推理过程同理（想什么不影响"这段对话在做什么"）。
   */
  private async readTranscript(conversationId: string, runId: string): Promise<string | null> {
    const page = await this.timelines.list({
      conversationId,
      runId,
      page: 1,
      size: 200,
    })
    const lines: string[] = []
    for (const item of page.items) {
      if (item.kind !== TimelineKind.Text) continue
      if (item.role !== TimelineRole.User && item.role !== TimelineRole.Assistant) continue
      const text = typeof item.payload?.text === 'string' ? item.payload.text.trim() : ''
      if (!text) continue
      lines.push(`${item.role === TimelineRole.User ? '用户' : '助手'}：${text}`)
    }
    if (lines.length === 0) return null
    const transcript = lines.join('\n')
    return transcript.length > TRANSCRIPT_MAX_CHARS
      ? `${transcript.slice(0, TRANSCRIPT_MAX_CHARS)}…`
      : transcript
  }
}
