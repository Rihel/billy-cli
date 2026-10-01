/**
 * 工具 **key** 的**唯一事实源**：工具 bean 用它声明 `key`，agent 定义用它做授权。
 *
 * 「key」是稳定对外标识（与 agent key 同一套词汇）；Mastra 的 `createTool({ id })` 是它的接口字段，
 * 装配处做一次映射（值相同），不把它的词引进我们的领域。
 *
 * 不把 key 写成裸字符串：agent 授权写错工具名，过去只会在运行时表现为「模型少了个能力」，
 * 现在是编译期错误（符号写错直接 undefined → 类型检查就红）。
 *
 * 当前工具都是**运行时能力**（一个工具一个 `@Injectable()` 类，用 `@ToolDecl` / `@ToolExec`
 * 装饰器声明）：AI 模块已与业务模块解耦，业务工具一个都没有（`AGENT_TOOLS` 是加工具的登记处）。
 */
export const TOOL_KEYS = {
  /**
   * 规划能力（**一组工具**，设计 §3.16）：
   * - `plan-create`：创建任务清单（一次性建多个任务；已有清单时是**追加**）
   * - `plan-reorder`：重排任务清单（改顺序 + 就地改标题 / 备注 / 状态，开始做某一项也用它）
   * - `plan-complete`：完成任务（支持一次完成多个）
   * - `plan-delete`：删除任务（支持一次删除多个）
   *
   * 四个工具都返回**完整清单**，于是「当前计划」仍然等于最后一条 `plan` 事件（协议不变）；
   * 它们都**只给主 agent**（`child: 'deny'`）—— 清单归属发起这一轮的主 agent。
   */
  planCreate: 'plan-create',
  planReorder: 'plan-reorder',
  planComplete: 'plan-complete',
  planDelete: 'plan-delete',
  /** 子 agent 能力：**运行期动态创建一个子 agent 并跑完**（提示词由主 agent 现写） */
  runSubAgent: 'run-sub-agent',
  /**
   * 命令执行能力：在本机跑一条命令行命令（跨平台：Windows `cmd.exe` / POSIX `/bin/sh`）。
   *
   * 安全边界见 `core/beans/command.tool.ts` 类注释：命令以**服务进程的身份与权限**执行，
   * 由 `agent.command*` 配置决定开关、默认落点目录与时长 / 输出上限。
   */
  runCommand: 'run-command',
  /**
   * 取页能力：读取某个工具结果的**后续页**（大返回分页的回取通道）。
   *
   * 内建工具（`ReadToolResultTool`），走同一套网关 —— 于是取页也受限流与审计约束。
   */
  readToolResult: 'read-tool-result',
} as const

/**
 * **运行时自带**的工具（不进注册机，后台只读展示；设计 §5.10 路线 A）。
 *
 * 来源是 Mastra 的 skills 特性：它给配了技能的 Agent 自动挂这三个（`listSkillTools`），
 * 网关拦不到、也没有开关与限额。列在这里是为了"后台工具清单与模型手上的工具对得上账"。
 */
export const RUNTIME_TOOLS: readonly { key: string; title: string; description: string }[] = [
  {
    key: 'skill',
    title: '激活技能（运行时自带）',
    description: '读取技能的完整说明（Mastra 在 Agent 层自动挂载，不受本工程的开关与限额控制）',
  },
  {
    key: 'skill_search',
    title: '检索技能内容（运行时自带）',
    description: '在技能正文里做关键词检索（同上，Mastra 自带）',
  },
  {
    key: 'skill_read',
    title: '读取技能文件（运行时自带）',
    description: '读取技能目录下的 references / scripts / assets（支持行区间，Mastra 自带）',
  },
]

/** 内建（工具类交出、但 key 单独收在这里）的工具 key */
export const TOOL_RESULT_KEYS = {
  readToolResult: TOOL_KEYS.readToolResult,
} as const

/** 工具 key 联合类型（工具类的 `@ToolDecl.key` 与 agent 声明的入参类型） */
export type ToolKey = (typeof TOOL_KEYS)[keyof typeof TOOL_KEYS]
