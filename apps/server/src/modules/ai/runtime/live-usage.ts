/**
 * 轮内**实时用量**：每步模型调用结束时，把"到目前为止"的消耗拼成一个 `data-step-usage` 块下发。
 *
 * ## 为什么需要这一层（用户反馈："用量不是实时刷新的，这一轮完了才刷新"）
 *
 * 1. 收尾的 `data-run-usage` 仍然权威（含子 agent、命名、记忆抽取的并账），但它只在**轮末**出现；
 * 2. 发给浏览器的 AI SDK **v6** UI 流里**不带 usage**：`@mastra/ai-sdk` 的 v6 映射把 Mastra 的
 *    `step-finish` 拍成裸 `{ type: 'finish-step' }`（只有 v5 那条分支带 usage），
 *    AI SDK 自己的 `finish-step` / `finish` schema 也不收 usage —— 前端中间拿不到任何数；
 * 3. 而 Mastra 的原始流里**有**：`step-finish` 的 `payload.output.usage` 就是这一步的计费。
 *
 * 做法：在 Mastra 原始流（`fullStream`）上挂一层 tee，见到 `step-finish` 就把这一步的用量累加进
 * 快照，并在**同一步的 `finish-step` 之后**补发 `data-step-usage`；原始片段一个字节都不改，
 * 适配器与录制器看到的流与原来完全一致。
 *
 * ## 口径（必须知道，改之前先读）
 *
 * - **实时值是下界**：子 agent 的消耗要收尾才从库里并进来（`rollUpUsage`），命名 / 记忆抽取也是
 *   收尾时的额外调用 —— 所以轮末那条 `data-run-usage` 会跳一下，这是正常的，不是漏算；
 * - **不编造**：provider 没上报用量时 `usage` 照旧是 `null`，前端整行不显示 token（不写 0）；
 * - **步数一定实时**：哪怕这一步没上报用量，`stepCount` 也加一（步数本身就是用户想看的反馈）。
 */

import { toUiStream } from '../mastra/stream.adapter.js'
import { mergeUsage, toUsageRecord } from './usage.js'

/** Mastra 原始流片段：我们只认 `step-finish` 的 `payload`，其余原样透传 */
interface RawChunkLike {
  type?: string
  payload?: Record<string, unknown>
}

/** UI Message Stream 片段（与编排层的 `UiChunkLike` 同形，这里不反向依赖它） */
interface UiChunkLike {
  type?: string
  [key: string]: unknown
}

export interface LiveUsageOptions {
  /** 应用 run id：前端靠它对上"这是哪一轮的实时值" */
  runId: string
  /** 本轮开始时间（实时耗时 = 现在 - 它） */
  startedAt: number
  /** 续跑：接上挂起前已经记下的用量（同一轮不能从 0 重数） */
  baseUsage?: Record<string, unknown> | null
  /** 续跑：挂起前已经跑过的步数 */
  baseSteps?: number
  /** 续跑：挂起前已经花掉的时长 */
  baseDurationMs?: number
}

interface StepReading {
  /** `delta` = 这一步自己的计费（累加）；`snapshot` = 上游给的累计值（覆盖） */
  mode: 'delta' | 'snapshot'
  usage: Record<string, unknown>
}

/**
 * 从一个流片段里读"这一步"的用量；不是 `step-finish` 或没有用量 → `null`。
 *
 * 两种字段都要认（实测口径，与 `usage.ts` 的注释一致）：
 * - `payload.output.usage`：这一步自己的计费 → 累加（正常路径）；
 * - `payload.totalUsage`：上游给的**累计值** → 覆盖（并**不能**再累加，否则步数越多翻倍越多）。
 *
 * @param chunk - Mastra 原始流片段。
 * @returns 读到的用量与它的口径；读不到返回 `null`（不编造 0）。
 */
export const stepUsageOf = (chunk: RawChunkLike): StepReading | null => {
  if (chunk?.type !== 'step-finish') return null
  const payload = chunk.payload ?? {}
  const output = (payload.output ?? {}) as Record<string, unknown>
  const delta = toUsageRecord(output.usage as Record<string, unknown> | undefined)
  if (delta) return { mode: 'delta', usage: delta }
  const snapshot = toUsageRecord(payload.totalUsage as Record<string, unknown> | undefined)
  return snapshot ? { mode: 'snapshot', usage: snapshot } : null
}

/**
 * 取 Mastra 的原始流：可恢复执行（durable）形态包在 `output` 字段里，普通形态直接就有
 * `fullStream`（两种形态的差异见 `stream-result.ts` 的注释）。取不到返回 `null`，调用方退回原路径。
 *
 * @param output - `agent.stream()` / `agent.resumeStream()` 的返回值。
 * @returns 原始片段流；没有就 `null`。
 */
const readFullStream = (output: unknown): ReadableStream<RawChunkLike> | null => {
  const candidate = (output as { fullStream?: unknown } | null | undefined)?.fullStream
  return candidate instanceof ReadableStream ? (candidate as ReadableStream<RawChunkLike>) : null
}

/**
 * 造一个"实时用量"包装器：`wrap(output)` 返回与 `toUiStream(output)` **同一条** UI 流，
 * 只是每步结束处多一个 `data-step-usage` 块。
 *
 * 状态（累计用量 / 步数）放在工厂闭包里而不是每次 `wrap` 重建：续跑会连着 `wrap` 两段流
 * （先恢复工具、再起继续 loop 的新引擎 run），两段的累计值必须是同一个。
 *
 * @param options - run 身份与续跑基数。
 * @returns `wrap(output)`：包装后的 UI 流。
 */
export const createLiveUsage = (options: LiveUsageOptions) => {
  let usage = options.baseUsage ?? null
  let steps = options.baseSteps ?? 0
  const baseDurationMs = options.baseDurationMs ?? 0
  /** 待插发的实时块：一步一个，按步顺序排队（下游慢时也不会被后一步覆盖） */
  const pending: UiChunkLike[] = []

  /** 记一步：步数无条件加一；用量读到了才并（读不到保持上一次的值，不写 0） */
  const observe = (chunk: RawChunkLike): void => {
    if (chunk?.type !== 'step-finish') return
    steps += 1
    const reading = stepUsageOf(chunk)
    if (reading) usage = reading.mode === 'delta' ? mergeUsage(usage, reading.usage) : reading.usage
    pending.push({
      type: 'data-step-usage',
      data: {
        runId: options.runId,
        usage,
        stepCount: steps,
        durationMs: baseDurationMs + (Date.now() - options.startedAt),
      },
    })
  }

  const wrap = (output: unknown): ReadableStream<unknown> => {
    const fullStream = readFullStream(output)
    // 拿不到原始流就照旧：宁可没有实时值，也不能把这一轮的流弄坏
    if (!fullStream) return toUiStream(output)
    const teed = fullStream.pipeThrough(
      new TransformStream<RawChunkLike, RawChunkLike>({
        transform(chunk, controller) {
          // 先透传再记账：下游（适配器）看到的片段顺序与内容都不变
          controller.enqueue(chunk)
          observe(chunk)
        },
      }),
    )
    return (toUiStream({ fullStream: teed }) as unknown as ReadableStream<UiChunkLike>).pipeThrough(
      new TransformStream<UiChunkLike, UiChunkLike>({
        transform(chunk, controller) {
          controller.enqueue(chunk)
          // 只挂在 `finish-step` 后面：一步一条，客户端按步看到增量，
          // 不会因为上游快下游慢而提前冒出来（实测过：挂在"任意下一片段"上是乱序的）
          if (chunk.type !== 'finish-step') return
          const injected = pending.shift()
          if (injected) controller.enqueue(injected)
        },
        flush(controller) {
          // 末步之后没有 `finish-step` 跟随时（理论兜底），也要把剩下的发出去
          while (pending.length > 0) {
            const injected = pending.shift()
            if (injected) controller.enqueue(injected)
          }
        },
      }),
    )
  }

  return { wrap }
}
