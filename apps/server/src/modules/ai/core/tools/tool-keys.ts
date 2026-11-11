/**
 * 工具 **key** 的**唯一事实源**：工具 bean 用它声明 `key`，agent 定义用它做授权。
 *
 * 「key」是稳定对外标识（与 agent key 同一套词汇）；Mastra 的 `createTool({ id })` 是它的接口字段，
 * 装配处做一次映射（值相同），不把它的词引进我们的领域。
 *
 * 不把 key 写成裸字符串：agent 授权写错工具名，过去只会在运行时表现为「模型少了个能力」，
 * 现在是编译期错误（符号写错直接 undefined → 类型检查就红）。
 *
 * 当前工具都是**运行时能力**（工具组：一个组一个 `@Injectable()` 类，组内一个 `@ToolDecl` 方法一个工具）：
 * AI 模块已与业务模块解耦，业务工具一个都没有（`AGENT_TOOL_GROUPS` 是加工具的登记处）。
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
   * 安全边界见 `tools/bash.tool.ts` 类注释：命令以**服务进程的身份与权限**执行，
   * 由 `agent.command*` 配置决定开关、默认工作目录与时长 / 输出上限。
   */
  bash: 'bash',
  /**
   * 取页能力：读取某个工具结果的**后续页**（大返回分页的回取通道）。
   *
   * 内建工具（`ReadToolResultTool`），走同一套网关 —— 于是取页也受限流与审计约束。
   */
  readToolResult: 'read-tool-result',
  /**
   * **搜索网页**：调 DeepSeek 搜索接口（`/v1/tools/search`），返回排序后的来源清单。
   *
   * 与 `web-fetch` 的分工：`web-search` 解决"**不知道答案在哪个网页**"（找来源），
   * `web-fetch` 解决"**已经拿到 URL**"（读正文）。**默认先直取**（fetch / request），
   * 搜索只在不知道来源时兜底；搜到 URL 仍回到 `web-fetch`，两者不是重复能力。
   */
  webSearch: 'web-search',
  /**
   * **抓网页**：下载 HTML → 转 Markdown → 按行分页返回（1 页 1000 行）。
   *
   * 与 `web-request` 的分工：它**只管读文章**（GET、洗正文、丢导航与脚本）。
   * 两者共用同一套出网预算（统一浏览器 UA / 超时 / 字节上限 / 内网拦截）
   * 与同一套分页缓存（`ref` + `page` 续读，不重复请求）。
   */
  webFetch: 'web-fetch',
  /**
   * **发 HTTP 请求**：任意方法 / 头 / body，拿状态码、响应头与响应体（同样按页返回）。
   *
   * 存在的理由：API 不是文章 —— JSON 洗成 Markdown 就没法用了，
   * 而"接口返回 401 还是 500"本身就是要看的结论。
   */
  webRequest: 'web-request',
  /**
   * **技能库**（一组四个工具，设计 `docs/design/ai-skill-library.md`）：
   * `skill-list`（看现有技能）/ `skill-save`（建或改，可一次带参考文件）/
   * `skill-delete`（删）/ `skill-enable`（启停）。
   *
   * 与 Mastra 自带的 `skill` / `skill_read` 是两套：那三个是**读**技能，
   * 这四个是**维护技能库**（写库 + 落盘），作用域 `admin`。
   */
  skillList: 'skill-list',
  skillSave: 'skill-save',
  skillDelete: 'skill-delete',
  skillEnable: 'skill-enable',
  skillImport: 'skill-import',
  /**
   * **文件管理**（一组九个工具，设计 `docs/design/ai-file-manager.md`）：
   * - OSS：`file-submit` / `file-download` / `file-list`；
   * - workspace：`read-file` / `file-search` / `workspace-files` /
   *   `write-file` / `replace-file` / `append-file`。
   */
  fileSubmit: 'file-submit',
  fileDownload: 'file-download',
  fileList: 'file-list',
  readFile: 'read-file',
  fileSearch: 'file-search',
  workspaceFiles: 'workspace-files',
  writeFile: 'write-file',
  replaceFile: 'replace-file',
  appendFile: 'append-file',
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

/** 内建（工具组交出、但 key 单独收在这里）的工具 key */
export const TOOL_RESULT_KEYS = {
  readToolResult: TOOL_KEYS.readToolResult,
} as const

/** 工具 key 联合类型（工具组 `@ToolDecl.key` 与 agent 声明的入参类型） */
export type ToolKey = (typeof TOOL_KEYS)[keyof typeof TOOL_KEYS]
