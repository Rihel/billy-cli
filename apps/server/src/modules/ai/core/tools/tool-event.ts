import { TOOL_EVENT_PART_TYPE } from '@repo/shared'
import type { AiToolEventModel } from '@repo/shared'
import type { ToolEventDecl, ToolEventDeclMeta, ToolEventModeValue, ToolLogger } from './tools.types.js'

/**
 * **工具自定义事件**（设计 §5.17）：声明归一化 + 运行时发射。
 *
 * 两件事放一个文件，因为它们是同一个机制的两端（声明里的 `mode` 直接决定发射时带不带 `id`）：
 *
 * 1. `normalizeToolEventDecls`：启动期把 `@ToolDecl({ events })` 的声明**校验 + 归一化**
 *    （zod 定义 → JSON Schema 镜像）。违规一律**抛错**（注册机在启动期调用它 —— 宁可起不来，
 *    也不要带着一个"声明了却发不出去"的事件跑）；
 * 2. `createToolEventEmitter`：把一次工具调用的 `emit` 造出来，形状 = AI SDK 的 `data-*` part。
 *
 * 三条口径：
 * - **未声明不许发**：`emit` 只认声明过的名字，payload 不符合定义也被丢弃（都记 warn 不外抛）——
 *   事件是过程，出参才是结论，事件失败不能拖垮工具；
 * - **归并策略在服务端定**：AI SDK v6 的 data part 是「同 `id` 后者覆盖前者」，
 *   所以 `state` 带稳定 id（前端只看到最新快照）、`stream` **不带 id**（前端按顺序追加）。
 *   把这条判断放在服务端，前端就不必自己实现去重 —— 协议怎么发，前端就怎么看到；
 * - **没有 writer 就静默 no-op**（后台调用 / 非流式链路没有父流可写，不是错误）。
 */

/** zod 定义的最小面（只用到 `toJSONSchema`；不 import zod 的运行时类型，避免多一层耦合） */
interface JsonSchemaCapable {
  toJSONSchema?: () => Record<string, unknown>
}

/**
 * payload 定义 → JSON Schema（**仅管理页只读展示**，让管理员看到"这个事件会吐什么"）。
 *
 * 与 `tool.schema.ts` 对 `params` 的做法一致：转不出来返回 null 而不是抛错 ——
 * 自定义 schema 转不出来只影响展示位，不该让整个工具引擎起不来。
 */
const toPayloadJsonSchema = (payload: unknown): Record<string, unknown> | null => {
  try {
    const schema = payload as JsonSchemaCapable
    return typeof schema?.toJSONSchema === 'function' ? schema.toJSONSchema() : null
  } catch {
    return null
  }
}

/** 校验：名字、标题、说明、mode（文案带上工具 key 与事件名，启动日志里能直接定位） */
const validateEvent = (decl: ToolEventDeclMeta, label: string, index: number): ToolEventModeValue => {
  const at = `${label} 的第 ${index + 1} 个事件声明`
  const name = decl?.name
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(`${at} 缺少事件名 name：每个事件都要有稳定名字（前端渲染器按它匹配）`)
  }
  const trimmed = name.trim()
  if (trimmed.length > 64) {
    throw new Error(`${label} 的事件名过长（最长 64）：${trimmed}（长度 ${trimmed.length}）`)
  }
  if (typeof decl.title !== 'string' || !decl.title.trim()) {
    throw new Error(`${label} 的事件 ${trimmed} 缺少标题 title（管理页与前端兜底渲染都要它）`)
  }
  if (typeof decl.description !== 'string' || !decl.description.trim()) {
    throw new Error(`${label} 的事件 ${trimmed} 缺少说明 description（写清什么时候发、payload 各字段什么意思）`)
  }
  const mode = decl.mode ?? 'state'
  if (mode !== 'state' && mode !== 'stream') {
    throw new Error(
      `${label} 的事件 ${trimmed} 的 mode 不合法：${String(mode)}（只能是 'state' 或 'stream'，省略 = 'state'）`,
    )
  }
  return mode
}

/**
 * 把一份 `@ToolDecl({ events })` 声明归一化成 `ToolSpec.events`。
 *
 * `label` 是报错定位串（注册机传"工具组类名.方法名（工具 key）"）——
 * 事件声明违规是**启动期错误**，文案必须能直接指到出问题的那个工具与事件。
 */
export const normalizeToolEventDecls = (
  decls: readonly ToolEventDeclMeta[] | undefined,
  label: string,
): readonly ToolEventDecl[] => {
  if (decls === undefined) return []
  if (!Array.isArray(decls)) {
    throw new Error(`${label} 的 events 必须是数组（一个事件一条声明）`)
  }
  const seen = new Set<string>()
  const normalized = decls.map((decl, index) => {
    const mode = validateEvent(decl, label, index)
    const name = decl.name.trim()
    if (seen.has(name)) {
      throw new Error(`${label} 的事件名重复：${name}（同一工具内事件名必须唯一）`)
    }
    seen.add(name)
    return {
      name,
      title: decl.title.trim(),
      description: decl.description.trim(),
      mode,
      ...(decl.payload ? { payload: decl.payload } : {}),
      payloadSchema: decl.payload ? toPayloadJsonSchema(decl.payload) : null,
    } satisfies ToolEventDecl
  })
  return normalized
}

/**
 * 归一化后的事件声明 → **入库镜像**（`AiToolEventModel[]`，设计 §5.17）。
 *
 * 种子同步与管理台读取共用这一处映射：库里那一列与代码声明的形状永远一致，
 * 于是"接口返回的 events 与声明一致"这条要求不必靠两条各写一遍的代码去维持。
 */
export const toAiToolEventModels = (decls: readonly ToolEventDecl[]): AiToolEventModel[] =>
  decls.map((decl) => ({
    name: decl.name,
    title: decl.title,
    description: decl.description,
    mode: decl.mode,
    payloadSchema: decl.payloadSchema,
  }))

/** `createToolEventEmitter` 的入参 */
export interface ToolEventEmitterOptions {
  /** 父流出口（Mastra 工具上下文给的）；没有就静默 no-op */
  writer?: { write(chunk: unknown): Promise<unknown> | unknown }
  /** 发事件的工具 key（part 里带上，前端据此并进对应工具卡） */
  toolKey: string
  /** 这一次工具调用的 id（非流式调用为 null） */
  toolCallId: string | null
  /** 调用方 agent key（无信封为 null） */
  agentKey: string | null
  /** 这个工具声明过的事件（`ToolSpec.events`；未声明的名字发不出去） */
  events: readonly ToolEventDecl[]
  /** 诊断日志（事件被丢弃 / 写流失败都要留下可排查的线索） */
  log: ToolLogger
}

/**
 * 造一次工具调用的 `emit`。
 *
 * 返回值是**同步函数且永不抛**（设计 §5.17 的硬要求）：执行体可以随便发，发失败只记日志。
 * 写流本身可能是异步的（Mastra 的 `writer.write` 返回 Promise），所以内部把写入**串成一条队列** ——
 * 于是"先 emit 的先进流"，`seq` 也只有一处递增（不靠调用方守顺序）。
 */
export const createToolEventEmitter = (
  options: ToolEventEmitterOptions,
): ((name: string, payload?: unknown) => void) => {
  const { writer, toolKey, toolCallId, agentKey, events, log } = options
  const byName = new Map(events.map((decl) => [decl.name, decl]))
  let seq = 0
  /** 写入队列：把可能异步的 write 串起来，保证先进流的顺序等于 emit 的顺序 */
  let queue: Promise<void> = Promise.resolve()

  const warn = (message: string, data: Record<string, unknown>): void => {
    log.warn(message, data)
  }

  return (name: string, payload?: unknown): void => {
    // 没有父流：后台调用 / 非流式链路，静默 no-op（不是错误）
    if (!writer) return
    const decl = byName.get(name)
    if (!decl) {
      warn('ai.tool.event_undeclared', {
        toolKey,
        event: name,
        hint: '事件必须先写进 @ToolDecl({ events }) 才能发（未声明不许发）',
      })
      return
    }
    if (decl.payload) {
      const parsed = decl.payload.safeParse(payload)
      if (!parsed.success) {
        warn('ai.tool.event_payload_invalid', {
          toolKey,
          event: name,
          issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`),
        })
        return
      }
    }
    const current = seq
    seq += 1
    /**
     * 形状与 `@repo/shared` 的 `ToolEventPartSchema` 逐字段对应：
     * `state` 带稳定 id（同一次调用的同一个事件只留最新一块），`stream` 刻意**不带 id**。
     */
    const chunk = {
      type: TOOL_EVENT_PART_TYPE,
      ...(decl.mode === 'state' ? { id: `${toolCallId ?? toolKey}:${name}` } : {}),
      data: {
        toolKey,
        toolCallId,
        event: name,
        eventTitle: decl.title,
        mode: decl.mode,
        seq: current,
        payload: payload ?? null,
        agentKey,
      },
    }
    queue = queue.then(async () => {
      try {
        await writer.write(chunk)
      } catch (error) {
        // 写流失败不是工具失败：吞掉并留一条可排查的 warn（工具照常返回出参）
        warn('ai.tool.event_write_failed', {
          toolKey,
          event: name,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    })
  }
}
