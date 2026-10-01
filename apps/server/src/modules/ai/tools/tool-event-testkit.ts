import { z } from 'zod'
import { ToolDecl, ToolGroup } from '../core/tools/tool.decorator.js'
import type { ToolCallContext } from '../core/tools/tools.types.js'

/**
 * **测试专用**的工具组：只给"事件声明"的测试用，**不进 `AGENT_TOOL_GROUPS`**。
 *
 * 为什么放在 `src/modules/ai/tools/` 而不是 `test/helpers/`：Vitest 对 `test/**` 下的文件
 * 不做 TypeScript 转换（Node 的类型擦除不认装饰器语法，直接 `SyntaxError: Invalid or unexpected token`），
 * 于是"在测试目录里定义一个带 `@ToolGroup` 的工具组"根本跑不起来。放在 `src/` 下与生产工具同一目录，
 * 走的就是已验证可用的那条转换链路；它不在 `AGENT_TOOL_GROUPS` 里，模型与注册机永远看不到它。
 * 代价由 `tsconfig.build.json` 里"排除所有名字含 testkit 的文件"那条规则兜住 —— **不进构建产物**；
 * 生产代码一旦误引它，`pnpm --filter @app/server run build` 会直接失败（刻意的哨兵）。
 *
 * 事件声明里引用的 zod 契约必须是**模块级常量**：装饰器在类定义期求值，
 * 引用类自身的 static 会拿到 undefined。
 */

/** 事件声明测试的入参契约（与本文件的事件无关，够用即可） */
export const EventDeclParams = z.object({ keyword: z.string() })

/** 事件声明测试的配置契约（每个字段都必须有默认值，注册机启动期会校验） */
export const EventDeclConfig = z.object({ enabled: z.boolean().default(true) })

/** payload 契约示例：转 JSON Schema 与运行时 `safeParse` 都用它 */
export const ProgressPayload = z.object({
  percent: z.number().min(0).max(100).describe('完成百分比'),
  note: z.string().optional(),
})

/** 声明齐全的工具组：默认 mode、显式 stream、带 payload 契约三种情形各一条 */
@ToolGroup({ category: 'core', scope: 'all' })
export class EventDeclTool {
  @ToolDecl({
    key: 'test-event-decl',
    title: '声明示例',
    description: '只用于测试事件声明归一化的工具',
    params: EventDeclParams,
    config: EventDeclConfig,
    events: [
      { name: 'progress', title: '进度', description: '阶段性进度快照', payload: ProgressPayload },
      { name: 'log-line', title: '日志行', description: '一行流水', mode: 'stream' },
      { name: 'stage', title: '阶段', description: '当前阶段（省略 mode 应为 state）', mode: 'state' },
    ],
  })
  async run(): Promise<Record<string, never>> {
    return {}
  }
}

/** 没有声明事件的工具组（验 `events` 的默认值） */
@ToolGroup({ category: 'core', scope: 'all' })
export class NoEventTool {
  @ToolDecl({
    key: 'test-no-event',
    title: '没有事件',
    description: '只用于测试 events 默认值',
    params: EventDeclParams,
    config: EventDeclConfig,
  })
  async run(): Promise<Record<string, never>> {
    return {}
  }
}

/** 事件名重复的工具组（验"违规 = 构建失败"） */
@ToolGroup({ category: 'core', scope: 'all' })
export class DuplicateEventTool {
  @ToolDecl({
    key: 'test-bad-event',
    title: '坏声明',
    description: '只用于测试事件声明违规',
    params: EventDeclParams,
    config: EventDeclConfig,
    events: [
      { name: 'dup', title: 'A', description: '第一次' },
      { name: 'dup', title: 'B', description: '第二次' },
    ],
  })
  async run(): Promise<Record<string, never>> {
    return {}
  }
}

/** 事件演示的入参：`keyword` 就是要当成流水行发出去的那段文本 */
const EventDemoParams = z.object({ keyword: z.string().min(1) })

/** 事件演示的配置（无旋钮，但契约必须有） */
const EventDemoConfig = z.object({})

/** 状态快照的 payload 契约（验"带了契约就按契约校验"） */
const EventProgressPayload = z.object({
  state: z.string(),
  percent: z.number().min(0).max(100),
})

/**
 * **端到端演示工具组**：一次调用里先发两条状态块（同 id，后者覆盖前者）再发一条流水块。
 *
 * 刻意做成"状态 + 流水"两件事，因为 `mode` 的归并语义正是这条链路要证明的东西：
 * 状态块必须带稳定 id（前端只看到最新快照），流水块必须不带 id（逐条追加）。
 */
@ToolGroup({ category: 'core', scope: 'all' })
export class ToolEventDemoTool {
  @ToolDecl({
    key: 'test-event-tool',
    title: '事件演示',
    description: '只用于测试自定义事件的工具（发出状态快照与流水行）',
    params: EventDemoParams,
    config: EventDemoConfig,
    events: [
      {
        name: 'progress',
        title: '进度快照',
        description: '阶段性状态（state：同 id 后者覆盖前者）',
        mode: 'state',
        payload: EventProgressPayload,
      },
      {
        name: 'line',
        title: '流水行',
        description: '一行过程明细（stream：不带 id，逐条追加）',
        mode: 'stream',
        payload: z.string(),
      },
    ],
  })
  async run(
    input: z.infer<typeof EventDemoParams>,
    ctx: ToolCallContext,
  ): Promise<{ echoed: string }> {
    ctx.emit('progress', { state: 'running', percent: 10 })
    ctx.emit('progress', { state: 'done', percent: 100 })
    ctx.emit('line', input.keyword)
    // 未声明的事件：被丢弃并记 warn（端到端也顺带证明"事件失败不影响出参"）
    ctx.emit('not-declared', { anything: true })
    return { echoed: input.keyword }
  }
}
