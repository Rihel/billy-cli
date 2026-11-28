import { Inject, Injectable } from '@nestjs/common'
import { Agent } from '@mastra/core/agent'
import { AppLogger } from '@repo/kits'
import type { RuntimeModel } from '../../foundation/envelope.js'
import { toMastraModelInstance } from '../../adapters/mastra/agent.adapter.js'
import { PROMPT_ENGINE, type PromptEngine } from '../../foundation/prompts/prompt.engine.js'
import { toUsageRecord } from '../run/usage.js'

/** 自动会话名的字符上限（用户口径：**10 个字符内**） */
export const TITLE_MAX_CHARS = 10

/** 这次命名调用的墙钟上限（ms）：起名是"锦上添花"，不能因为模型慢把一轮问答拖住 */
const TITLE_TIMEOUT_MS = 10_000

/**
 * 输出长度上限。
 *
 * **不能按"名字只要 10 字"给 32 token**：推理型模型（线上的 deepseek-flash 就是）会把
 * 预算先花在 reasoning 上，32 个 token 全用在思考、正文一个字不剩 —— 现场表现是
 * `ai.conversation.title_empty`、标题永远停在兜底名（2026-11-18 实测）。给 256 让它想完，
 * 名字长度另有 `sanitizeTitle` 按码点截断兜着。
 */
const TITLE_MAX_OUTPUT_TOKENS = 256

/** 送进模型的消息上限（字符）：命名只需要"用户在说什么"，不需要全文 */
const MESSAGE_MAX_CHARS = 2_000

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
    .replace(/^["'“”‘’「」『』《》〈〉【】[\]()（）*_#`~\s\d.、>-]+/, '')
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
 * **首轮会话命名**：把用户这一轮发来的消息交给模型，换回一个 ≤10 字的会话名。
 *
 * 三条硬要求（用户口径 + 工程口径）：
 * 1. **与当前 agent 上下文完全隔离**：这里**不用** Mastra 实例上那个 agent，而是现场造一个
 *    只有"命名指令"、**没有工具 / 技能 / 记忆 / 运行时信封**的临时 agent ——
 *    它看不到会话系统提示词，也拿不到任何工具，只有"消息 → 名字"这一件事；
 * 2. **只读用户这条消息**：命名与主回答**并行**跑（run 一启动就起跑），此时还没有助手回复
 *    可读；消息按字符数封顶，粘贴的大段日志不需要整份喂进去；
 * 3. **失败不影响这一轮**：超时 / 模型报错 / 被取消 / 输出收拾不出名字 → 返回 null，
 *    调用方保留兜底标题。
 *
 * 模型仍用**这一轮实际使用的那个**（管理员配的）—— 换一个"便宜的模型"就多一份配置与授权面，
 * 而这一次调用只要几十个 token。
 */
@Injectable()
export class AgentTitleService {
  constructor(
    @Inject(PROMPT_ENGINE) private readonly prompts: PromptEngine,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /**
   * 起一个名字；起不出来返回 null（**不会抛**，调用方按"没起成"处理）。
   *
   * `signal` 是这一轮的中止信号：用户点停止 → 这次命名调用跟着断开，
   * 不让一个已经没有人在等的助手继续烧 token。
   */
  async generateFirstTurnTitle(input: {
    conversationId: string
    runId: string
    /** 用户这一轮发来的消息 */
    message: string
    model: RuntimeModel
    /** 这一轮的中止信号（可选：非流式入口没有可取消的运行） */
    signal?: AbortSignal
  }): Promise<FirstTurnTitle | null> {
    const message = input.message.trim()
    if (!message) return null
    const content =
      message.length > MESSAGE_MAX_CHARS ? `${message.slice(0, MESSAGE_MAX_CHARS)}…` : message

    const startedAt = Date.now()
    try {
      /**
       * 模型实例**必须走 `toMastraModelInstance`**（和主回答同一个入口）。
       *
       * 踩过的坑：这里原先用 `decideModelForMastra(model).model` —— 那只是一段
       * `{ id, apiKey }` 描述。生产环境模型全走内部网关（`apiKey` 是空串、真实 key 只在网关），
       * Mastra 拿空 key 去官方端点，**请求在本地就失败了**，一次也没打到网关：
       * 库里所有会话标题于是全是"首条消息截断"的兜底名（2026-11-18 用会话
       * `e7l7rsk8d35rwemgjgdh` + `model_gateway_usage` 只有 1 条记录定位到）。
       * 这个函数在网关模式下会造"指向网关 + 内部令牌 + 归因头"的真实例，用量也能记到这一轮。
       */
      const { instance } = await toMastraModelInstance(input.model)
      // 隔离就体现在这一行：临时 agent，自己的指令、没有工具 / 技能 / 记忆，也没有 requestContext
      const agent = new Agent({
        id: 'conversation-title',
        name: '会话命名',
        instructions: this.prompts.renderPartial('title', { maxChars: TITLE_MAX_CHARS }),
        model: instance as never,
      })
      const result = await agent.generate([{ role: 'user', content }] as never, {
        maxSteps: 1,
        modelSettings: { maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS },
        // 自身超时 + 本轮中止信号合并：任一触发都结束这次调用
        abortSignal: input.signal
          ? AbortSignal.any([input.signal, AbortSignal.timeout(TITLE_TIMEOUT_MS)])
          : AbortSignal.timeout(TITLE_TIMEOUT_MS),
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
      // 起名失败（含被取消）不能影响这一轮：记一条 warn，调用方保住"首条消息"那版标题
      this.logger.warn(
        input.signal?.aborted ? 'ai.conversation.title_aborted' : 'ai.conversation.title_failed',
        {
          conversationId: input.conversationId,
          runId: input.runId,
          reason: error instanceof Error ? error.message : String(error),
        },
      )
      return null
    }
  }
}
