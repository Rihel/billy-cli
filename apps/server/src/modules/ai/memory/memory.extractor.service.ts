import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import {
  AiMemoryKind,
  AiMemoryKindField,
  MEMORY_CONTENT_MAX,
  TimelineKind,
  TimelineRole,
} from '@repo/shared'
import { z } from 'zod'
import { PROMPT_ENGINE, type PromptEngine } from '../core/prompts/prompt.engine.js'
import { TOOL_KEYS } from '../core/tools/tool-keys.js'
import type { RuntimeModel } from '../core/envelope.js'
import { runMemoryExtraction } from '../mastra/memory-extractor.js'
import { TimelineRepository } from '../runtime/timeline.repository.js'
import { toUsageRecord } from '../runtime/usage.js'
import { MemoryService, type MemoryCandidate } from './memory.service.js'

/** 每 N 轮扫一次（信号词命中时不用等） */
export const EXTRACT_EVERY_TURNS = 6
/** 一次最多写几条（抽取宁可少，不要多） */
export const EXTRACT_MAX_CANDIDATES = 3
/** 抽取调用上限：不能因为"锦上添花"把一轮收尾拖住 */
const EXTRACT_TIMEOUT_MS = 8_000
const EXTRACT_MAX_OUTPUT_TOKENS = 400
/** 送给模型的对话长度上限（够判断"值不值得记"，不需要全文） */
const TRANSCRIPT_MAX_CHARS = 4_000

/**
 * 信号词：用户明确表达"这是长期信息"时才抽。
 *
 * 刻意保守：每轮都抽的话成本翻倍，而且大部分轮次没有可记的东西。
 */
const SIGNAL_PATTERN = /记住|记一下|记着|以后|每次|从不|别再|我习惯|我是|我的|偏好|喜欢|不喜欢|叫我/

/** 这一轮该不该尝试抽取（纯函数，便于单测） */
export const shouldTryExtraction = (userMessage: string, turnCount: number): boolean => {
  if (SIGNAL_PATTERN.test(userMessage)) return true
  return turnCount > 0 && turnCount % EXTRACT_EVERY_TURNS === 0
}

const CandidateSchema = z.object({
  kind: AiMemoryKindField.optional(),
  content: z.string().trim().min(2).max(MEMORY_CONTENT_MAX),
  key: z.string().trim().min(1).max(64).optional(),
})

/**
 * 解析模型输出：只认 JSON 数组，允许外面套一层 Markdown 代码块。
 *
 * 模型不听话是常态（先解释再给 JSON、包 ```json），所以这里"容忍外壳、严格校验内容"：
 * 剥掉代码块、截取第一个 `[` 到最后一个 `]`，逐条 safeParse，不合格的丢掉。
 */
export const parseExtractionCandidates = (text: string | null): MemoryCandidate[] => {
  if (!text) return []
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start < 0 || end <= start) return []

  let raw: unknown
  try {
    raw = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []

  const candidates: MemoryCandidate[] = []
  for (const item of raw) {
    const parsed = CandidateSchema.safeParse(item)
    if (!parsed.success) continue
    candidates.push({
      kind: parsed.data.kind ?? AiMemoryKind._source.Fact.value,
      content: parsed.data.content,
      ...(parsed.data.key ? { key: parsed.data.key } : {}),
    })
    if (candidates.length >= EXTRACT_MAX_CANDIDATES) break
  }
  return candidates
}

export interface MemoryExtractionInput {
  conversationId: string
  runId: string
  userId: string
  agentKey: string
  userMessage: string
  /** 这一轮开始前的已完成轮数（0 = 首轮） */
  turnCount: number
  model: RuntimeModel
}

export interface MemoryExtractionResult {
  /** 这次抽取调用的用量（交给调用方并入本轮账本） */
  usage: Record<string, unknown> | null
  /** 实际写入 / 更新的条数 */
  saved: number
}

/**
 * 轮后自动抽取（设计 `docs/design/ai-memory.md` §5.6）。
 *
 * 触发条件（满足一条才跑）：
 * 1. 用户消息里有"记住 / 以后 / 我习惯"这类信号；
 * 2. 每 N 轮扫一次；
 * 3. 这一轮模型**没有**自己调 `memory-save`（它已经记过就不重复抽）。
 *
 * 失败一律静默：抽取是锦上添花，不能影响这一轮的收尾。
 */
@Injectable()
export class MemoryExtractorService {
  constructor(
    @Inject(TimelineRepository) private readonly timelines: TimelineRepository,
    @Inject(MemoryService) private readonly memories: MemoryService,
    @Inject(PROMPT_ENGINE) private readonly prompts: PromptEngine,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async maybeExtract(input: MemoryExtractionInput): Promise<MemoryExtractionResult | null> {
    if (!shouldTryExtraction(input.userMessage, input.turnCount)) return null
    if (await this.timelines.hasToolCall(input.runId, TOOL_KEYS.memorySave)) return null

    const answer = await this.timelines.lastTextOfRun(input.runId)
    if (!answer || !answer.trim()) return null

    const transcript = `用户：${input.userMessage}\n助手：${answer}`.slice(0, TRANSCRIPT_MAX_CHARS)
    const startedAt = Date.now()
    try {
      const instructions = this.prompts.renderPartial('memory-extract', {
        maxItems: EXTRACT_MAX_CANDIDATES,
      })
      const result = await runMemoryExtraction({
        model: input.model,
        instructions,
        transcript,
        timeoutMs: EXTRACT_TIMEOUT_MS,
        maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
      })
      const candidates = parseExtractionCandidates(result.text)
      const saved =
        candidates.length > 0
          ? await this.memories.saveExtracted(input.userId, input.agentKey, candidates)
          : 0

      if (saved > 0) {
        // 时间线留痕：后台审计能看出"这一轮记了什么"（会话正文不渲染，见 history.ts 的口径）
        await this.timelines
          .append({
            conversationId: input.conversationId,
            runId: input.runId,
            role: TimelineRole.System,
            kind: TimelineKind.Memory,
            payload: {
              text: candidates.map((item) => `- [${item.kind}] ${item.content}`).join('\n'),
              saved,
              items: candidates,
            },
            finishedAt: new Date(),
          })
          .catch((error: unknown) => {
            this.logger.warn('ai.memory.event_failed', {
              conversationId: input.conversationId,
              runId: input.runId,
              reason: error instanceof Error ? error.message : String(error),
            })
          })
      }

      this.logger.log('ai.memory.extracted', {
        conversationId: input.conversationId,
        runId: input.runId,
        candidates: candidates.length,
        saved,
        durationMs: Date.now() - startedAt,
      })
      return { usage: toUsageRecord(result.usage as never), saved }
    } catch (error) {
      this.logger.warn('ai.memory.extract_failed', {
        conversationId: input.conversationId,
        runId: input.runId,
        reason: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      })
      return null
    }
  }
}
