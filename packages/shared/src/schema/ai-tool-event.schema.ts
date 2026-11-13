import { z } from 'zod'
import { ToolEventMode } from '../dicts/ai-tool-event.dict'

/**
 * 工具自定义事件：**声明**（DSL `@ToolDecl({ events })` → 入库 `ai_tools.events` 镜像）
 * 与**线上形态**（AI SDK `data-*` 流 part）共用同一份数据结构（设计 §5.17）。
 *
 * 为什么两件事放一个文件：它们是同一数据结构的两端 —— 代码里声明了哪些事件，流里就按**同名**发出来，
 * 前端按同名找渲染器；改名字 / 改 mode / 改 payload 三者必然同因变更，拆开只会漂移。
 *
 * 三条口径：
 * - **事件是过程，出参是结论**：事件只走流（实时渲染，`stream-recorder` 不落行 —— 与
 *   `data-sub-agent*` 同口径）；刷新后还要看见的东西必须写进**工具出参**（出参全量落库）；
 * - **`mode` 在服务端定归并策略**：AI SDK data part 是「同 `id` 后者覆盖前者」，
 *   于是 `state` 带稳定 id（前端只看到最新快照）、`stream` 不带 id（前端按顺序追加）；
 * - **未声明不许发**：`emit` 只认声明过的名字（同名重复声明是启动期错误），
 *   未声明或 payload 不符合定义的事件被**丢弃并记 warn**（不抛给工具，事件失败不能拖垮工具）。
 */

/** 事件发出方式的取值（字典是唯一事实源） */
export const ToolEventModeField = z.enum(ToolEventMode.values as unknown as [string, ...string[]])

/**
 * 事件声明（DSL → `ai_tools.events` 镜像）。
 *
 * `payloadSchema` 是**声明里 zod 定义的 JSON Schema 化**（没有 payload 时为 null）：
 * 管理页只读展示，让人一眼看出"这个工具会吐什么、里面的字段是什么"。
 */
export const AiToolEventSchema = z.object({
  /** 事件名：工具内唯一，前端渲染器按它匹配（禁止裸字符串拼接，用声明里的常量） */
  name: z.string().min(1).max(64),
  /** 人读标题（管理页展示 + 前端兜底渲染的标题） */
  title: z.string(),
  /** 什么时候发、payload 各字段什么意思 */
  description: z.string(),
  /** 见 `ToolEventMode` 字典 */
  mode: ToolEventModeField,
  /** payload 的 JSON Schema（声明里没写 payload 定义时为 null） */
  payloadSchema: z.record(z.string(), z.unknown()).nullable(),
})

export type AiToolEventModel = z.infer<typeof AiToolEventSchema>

/** 流 part 类型：工具自定义事件（AI SDK `data-*` 约定，与 `data-sub-agent*` 同构） */
export const TOOL_EVENT_PART_TYPE = 'data-tool-event'

/**
 * 事件 part 的负载。
 *
 * 刻意**自带描述字段**（`eventTitle` / `mode`）：前端渲染器是**代码注册**的，
 * 拿不到库里那份声明；认不出的事件靠这两个字段也能渲染出一条像样的兜底卡片。
 */
export const ToolEventPartDataSchema = z.object({
  /** 发事件的工具 key */
  toolKey: z.string(),
  /** 这次工具调用的 id（前端据此把事件并进对应工具卡；非流式调用为 null） */
  toolCallId: z.string().nullable(),
  /** 事件名（= 声明里的 `name`） */
  event: z.string(),
  /** 事件标题（= 声明里的 `title`，兜底渲染用） */
  eventTitle: z.string(),
  /** 见 `ToolEventMode` 字典 */
  mode: ToolEventModeField,
  /** 同一次工具调用内的发出序号（从 0 起；审计与测试断言顺序用） */
  seq: z.number().int().nonnegative(),
  /** 负载（已按声明校验；不落库、不进日志，脱敏由 `redact` 插件管出参） */
  payload: z.unknown(),
  /** 发出方 agent key（子 agent 里发的事件据此归组；无信封时为 null） */
  agentKey: z.string().nullable(),
})

export type ToolEventPartData = z.infer<typeof ToolEventPartDataSchema>

/**
 * 工具自定义事件的流 part（服务端写、前端读）。
 *
 * `id` 的有无就是 `mode`：省略 = 流水块（追加），给值 = 状态块（覆盖）。
 */
export const ToolEventPartSchema = z.object({
  type: z.literal(TOOL_EVENT_PART_TYPE),
  id: z.string().optional(),
  data: ToolEventPartDataSchema,
})

export type ToolEventPart = z.infer<typeof ToolEventPartSchema>

/**
 * 宽容解析：认不出的事件 part 返回 null，由调用方按"未知 part"处理（看得见比静默丢掉好排障）。
 *
 * 前端**必须**走它而不是自己断言类型 —— 协议演进时宁可露个徽标，也不要白屏。
 */
export function parseToolEventPart(part: unknown): ToolEventPart | null {
  const parsed = ToolEventPartSchema.safeParse(part)
  return parsed.success ? parsed.data : null
}
