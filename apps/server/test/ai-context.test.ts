import { describe, expect, it, vi } from 'vitest'
import type { TimelineEntity } from '../src/database/entities/timeline-entity.js'
import type { AgentConfig as AgentConfigValue } from '../src/modules/ai/core/ai.config.js'
import {
  ContextService,
  estimateTokens,
} from '../src/modules/ai/runtime/context.service.js'
import type { TimelineRepository } from '../src/modules/ai/runtime/timeline.repository.js'

/**
 * 上下文组装的纯逻辑测试（不连库、不调模型）：
 * 覆盖「70% 触发 → 裁剪 → 压缩 → 兜底」的取舍，以及"工具调用与结果配对不可拆""落库保真"这两条硬规则。
 */

const config: AgentConfigValue = {
  model: 'deepseek/deepseek-chat',
  apiKey: 'test-key',
  contextTriggerRatio: 0.7,
  contextTrimTargetRatio: 0.5,
  contextCompactTargetRatio: 0.4,
  contextKeepRecentTurns: 3,
  contextToolResultMaxRatio: 0.1,
  contextFallbackWindow: 32_000,
  contextModelWindows: {},
}

const warn = vi.fn()
const logger = { log: () => undefined, warn, error: () => undefined } as never

/** 造一条时间线事件 */
let seq = 0
const event = (partial: Partial<TimelineEntity>): TimelineEntity =>
  ({
    seq: ++seq,
    conversationId: 'c1',
    role: 'assistant',
    kind: 'text',
    payload: {},
    ...partial,
  }) as TimelineEntity

/** 造 n 轮问答（每轮：user 文本 + assistant 文本） */
const turns = (n: number, textSize = 10): TimelineEntity[] => {
  const list: TimelineEntity[] = []
  for (let i = 1; i <= n; i += 1) {
    list.push(event({ role: 'user', kind: 'text', payload: { text: `问${i}`.repeat(textSize) } }))
    list.push(
      event({ role: 'assistant', kind: 'text', payload: { text: `答${i}`.repeat(textSize) } }),
    )
  }
  return list
}

const buildService = (
  events: TimelineEntity[],
  summary: TimelineEntity | null = null,
): ContextService => {
  const timelines = {
    latestSummary: async () => summary,
    listSince: async () => events,
  } as unknown as TimelineRepository
  return new ContextService(timelines, config, logger)
}

describe('estimateTokens（保守估算）', () => {
  it('中文按字、英文按 4 字符', () => {
    expect(estimateTokens('你好世界')).toBe(4)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcdefgh')).toBe(2)
  })
})

describe('窗口解析（三级）', () => {
  it('配置覆盖优先', () => {
    const service = buildService([])
    const withOverride = new ContextService(
      { latestSummary: async () => null, listSince: async () => [] } as unknown as TimelineRepository,
      { ...config, contextModelWindows: { 'deepseek/deepseek-chat': 65_536 } },
      logger,
    )
    expect(withOverride.resolveWindow('deepseek/deepseek-chat')).toEqual({
      windowTokens: 65_536,
      source: 'config',
    })
    // 未覆盖的模型走注册表
    expect(service.resolveWindow('deepseek/deepseek-chat').source).toBe('registry')
  })

  it('注册表查不到 → 保守默认 + warn（不静默）', () => {
    warn.mockClear()
    const service = buildService([])
    const result = service.resolveWindow('no-such-provider/no-such-model')
    expect(result).toEqual({ windowTokens: 32_000, source: 'fallback' })
    expect(warn).toHaveBeenCalledWith(
      'ai.context.window.unknown',
      expect.objectContaining({ modelId: 'no-such-provider/no-such-model' }),
    )
  })
})

describe('组装策略（70% 触发 → 裁剪 → 压缩 → 兜底）', () => {
  it('用量很小 → 直接用（window），全部事件带入', async () => {
    seq = 0
    const service = buildService(turns(2))
    const built = await service.buildInput({
      conversationId: 'c1',
      modelId: 'deepseek/deepseek-chat',
      systemPrompt: '你是助手',
      userMessage: '再说说',
    })
    expect(built.snapshot.strategy).toBe('window')
    expect(built.snapshot.droppedSeqs).toEqual([])
    expect(built.snapshot.includedSeqs.length).toBeGreaterThan(0)
    expect(built.needsCompaction).toBe(false)
  })

  it('超 70% → 裁剪（trim），最近 3 轮被保护、丢弃区间如实记录', async () => {
    seq = 0
    // 每轮约 10k token（中文重复），窗口 128k → 触发线 89.6k：20 轮必然超
    const service = buildService(turns(20, 5_000))
    const built = await service.buildInput({
      conversationId: 'c1',
      modelId: 'deepseek/deepseek-chat',
      systemPrompt: '你是助手',
      userMessage: '继续',
    })
    expect(['trim', 'trim+compact', 'fallback']).toContain(built.snapshot.strategy)
    expect(built.snapshot.droppedSeqs.length).toBeGreaterThan(0)
    // 保护：最后一轮一定还在
    const includedLast = built.snapshot.includedSeqs.at(-1)![1]
    expect(includedLast).toBe(40)
  })

  it('裁剪还不够 → 要求压缩（needsCompaction + 区间），且**不动最近 N 轮**', async () => {
    seq = 0
    // 保护区（最近 3 轮）本身就把触发线撑满，且前面有可裁的旧轮 → 应当转而要求"压缩旧内容"
    const events = [...turns(5, 3_000), ...turns(3, 12_000)]
    const service = buildService(events)
    const built = await service.buildInput({
      conversationId: 'c1',
      modelId: 'deepseek/deepseek-chat',
      systemPrompt: '你是助手',
      userMessage: '继续',
    })
    expect(built.needsCompaction).toBe(true)
    expect(built.compactionRange).not.toBeNull()
    // 压缩区间就是被裁掉的那一段：必须落在保留区间之前
    expect(built.compactionRange!.toSeq).toBeLessThan(built.snapshot.includedSeqs[0][0])
  })

  it('系统提示词 + 最近 1 轮都装不下 → 抛 3307（不硬塞）', async () => {
    seq = 0
    const service = buildService(turns(2, 80_000))
    await expect(
      service.buildInput({
        conversationId: 'c1',
        modelId: 'deepseek/deepseek-chat',
        systemPrompt: '你是助手',
        userMessage: '继续',
      }),
    ).rejects.toMatchObject({ code: 3307 })
  })
})

describe('两条硬规则', () => {
  it('工具调用与结果配成一段（永不拆开），且结果在段内', async () => {
    seq = 0
    const events: TimelineEntity[] = [
      ...turns(1),
      event({
        role: 'assistant',
        kind: 'tool-call',
        toolKey: 'todo-write',
        toolCallId: 'call_1',
        payload: { toolCallId: 'call_1', input: { todoId: 't1' } },
      }),
      event({
        role: 'assistant',
        kind: 'tool-result',
        toolKey: 'todo-write',
        toolCallId: 'call_1',
        payload: { toolCallId: 'call_1', output: { title: '完整出参' } },
      }),
    ]
    const service = buildService(events)
    const built = await service.buildInput({
      conversationId: 'c1',
      modelId: 'deepseek/deepseek-chat',
      systemPrompt: '你是助手',
      userMessage: '继续',
    })
    // tool-call 与 tool-result 都在
    expect(built.snapshot.includedSeqs).toEqual([[1, 4]])
    const toolResultMessage = built.messages.find((m) => m.role === 'tool')
    expect(toolResultMessage).toBeDefined()
    // 保真：模型看到的出参是完整对象（未超阈值时不截断）
    expect(JSON.stringify(toolResultMessage)).toContain('完整出参')
  })

  it('单条工具结果超阈值 → 给模型的是截断视图，但快照记下裁剪事实', async () => {
    seq = 0
    const huge = { items: new Array(2000).fill({ title: '很长很长的待办标题'.repeat(5) }) }
    const events: TimelineEntity[] = [
      event({ role: 'user', kind: 'text', payload: { text: '查一下' } }),
      event({
        role: 'assistant',
        kind: 'tool-call',
        toolKey: 'todo-write',
        toolCallId: 'call_2',
        payload: { input: {} },
      }),
      event({
        role: 'assistant',
        kind: 'tool-result',
        toolKey: 'todo-write',
        toolCallId: 'call_2',
        payload: { output: huge },
      }),
    ]
    const service = buildService(events)
    const built = await service.buildInput({
      conversationId: 'c1',
      modelId: 'deepseek/deepseek-chat',
      systemPrompt: '你是助手',
      userMessage: '继续',
    })
    expect(built.snapshot.toolResultTrim.trimmedCount).toBe(1)
    expect(JSON.stringify(built.messages)).toContain('已截断')
  })

  it('推理过程只审计、不进模型输入（避免把思维链当上下文反复回灌）', async () => {
    seq = 0
    const events: TimelineEntity[] = [
      event({ role: 'user', kind: 'text', payload: { text: '问' } }),
      event({ role: 'assistant', kind: 'reasoning', payload: { text: '我在想…' } }),
    ]
    const service = buildService(events)
    const built = await service.buildInput({
      conversationId: 'c1',
      modelId: 'deepseek/deepseek-chat',
      systemPrompt: '你是助手',
      userMessage: '继续',
    })
    expect(JSON.stringify(built.messages)).not.toContain('我在想')
    expect(built.snapshot.includedSeqs).toEqual([[1, 1]])
  })
})
