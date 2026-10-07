import dedent from 'dedent'
import { Eta } from 'eta'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 提示词模板渲染数据（模板里通过 `it` 访问）。
 *
 * 工具清单由**实际授权的工具子集**注入（见 `agents/index.ts`），模板只负责排版。
 */
export interface PromptData {
  /** agent key（可用于模板里做差异化分支 / 自述） */
  agentKey: string
  /** agent 展示名 */
  agentName: string
  /** 该 agent 被授权的工具（工具 key + 标题 + 说明，来自 ToolRegistry.describe） */
  tools: ReadonlyArray<{ key: string; title: string; description: string }>
  /** 模板自定义变量（agent 定义里传） */
  [key: string]: unknown
}

/**
 * 模板标签：`{{ }}` 执行、`{{= }}` 插值、`{{~ }}` 原样输出（include 用）、
 * 以及用 JS 块注释写模板内注释。
 *
 * 为什么不用 eta 默认的 `<% %>`：提示词是 Markdown 正文，里面大量出现 `<` `>`（占位符
 * 如 `<todoId>`、HTML 示例、伪 XML 结构），`<%` 这类标签很容易与正文内容撞上；
 * `{{ }}` 从视觉上就与 Markdown 正文区分得开。
 * 副作用与写法约定：正文里**字面量** `{{` 会被当作标签，需要用 `{{= '{{' }}` 输出。
 */
const TEMPLATE_TAGS: [string, string] = ['{{', '}}']

/**
 * 提示词引擎：**eta 模板 → 提示词文本**（工程内提示词的唯一出口）。
 *
 * 为什么提示词要做成模板而不是 TS 常量字符串：
 * 1. **不会与授权漂移** —— 模板里那段"可用工具"由 agent 定义的 tools 渲染出来，
 *    改了授权清单，提示词自动跟着变（常量字符串做不到，只能靠人记得同步）；
 * 2. **公共段落复用** —— 语气 / 语言 / 安全约定写成 `partials/`，多 agent 共享一份，
 *    改一次全生效（`include` 机制）；
 * 3. **可校验** —— 模板缺失 / 语法错在**启动期**就报错并列出可用模板，不是等用户提问时才 500。
 *
 * 两个刻意的配置（都不是默认值，写清楚原因）：
 * - `autoEscape: false`：提示词是纯文本，eta 默认按 HTML 转义会把引号变成 `&#34;`、
 *   `<` 变成 `&lt;`，模型读到的就是坏文本；
 * - `cache: true`：编译结果按模板名缓存，每次对话只做一次字符串拼接级别的渲染。
 *
 * 渲染结果只做**首尾空行**清理，**不再 `dedent` 一遍**：模板渲染出来的缩进是有意义的
 * （Markdown 列表续行的 2 空格），而 `dedent` 是"按所有非空行的最小缩进取齐" ——
 * 对一份**已经渲染好**的文本再跑一遍，等于把真正需要保留的公共缩进也削掉。
 * `dedent` 的正确用法是包住**源码里手写的模板字面量**（模块里的工具说明 / 指令就是这么写的）：
 * 源码可以按代码缩进排版，运行时还原成顶格文本。它有一个坑：字面量**要以换行开头**，
 * 否则第一行会被当成"没有缩进"而多削一层 —— `dedent('- 第一行\n  第二行续')` 会把续行的 2 空格吃掉。
 *
 * 失败抛普通 `Error`（不是 `AppError`）：模板问题是**装配期**问题，应当在启动时炸出来，
 * 不需要走边界错误码映射。
 */
export interface PromptEngine {
  /** 渲染模板（不存在 / 语法错 → 抛错，错误信息带模板名与可用清单） */
  render: (template: string, data: PromptData) => string
  /**
   * 渲染**片段**（partial）：数据是任意键值。
   *
   * 与 `render` 的区别只有类型定义：agent 提示词的模板数据必须带
   * `agentKey` / `agentName` / `tools`（工具清单与实际授权同源，不许漏），
   * 而「运行环境」这类**按轮求值**的片段没有这些字段 —— 用一个显式的口子区分，
   * 不去放宽 `PromptData`（放宽了，工具清单漏注入就没人拦得住了）。
   */
  renderPartial: (template: string, data: Record<string, unknown>) => string
  /** 全部可用模板名（诊断 / 测试用） */
  templateNames: () => string[]
}

/**
 * 提示词引擎的注入 token。
 *
 * 引擎本身是工厂产物（`createPromptEngine()`），装配期渲染 agent 定义要用它；
 * **运行期也要用它** —— 会话开局那段「运行环境」（操作系统 + 当前时间）是按轮渲染的，
 * 不能写死在装配期的提示词里。于是它进容器（value provider），与「不走容器」的
 * 纯函数工具区分开：判断标准仍是「有没有第二处消费方」。
 */
export const PROMPT_ENGINE = Symbol.for('PromptEngine')

export interface PromptEngineOptions {
  /** 模板目录；默认本文件同级的 `templates/`（dev 走 src，构建后走 dist，由 copy-assets 保证存在） */
  templatesDir?: string
}

/** 默认模板目录：`import.meta.dirname` 在 dev（tsx 直跑 src）与 prod（dist）下都指向本文件所在目录 */
const defaultTemplatesDir = (): string => join(import.meta.dirname, 'templates')

export const createPromptEngine = (options: PromptEngineOptions = {}): PromptEngine => {
  const views = options.templatesDir ?? defaultTemplatesDir()
  const eta = new Eta({ views, cache: true, autoEscape: false, tags: TEMPLATE_TAGS })

  const render = (template: string, data: object): string => {
    try {
      // 只清首尾空行，保留正文里的缩进（见上方注释：不要对渲染结果再 dedent）
      return eta.render(template, data).replace(/^\n+/, '').replace(/\s+$/, '')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(
        dedent`
          提示词模板渲染失败: ${template}
          模板目录: ${views}
          可用模板: ${listTemplateNames(views).join(', ')}
          原因: ${reason}
        `,
      )
    }
  }

  return {
    render: (template, data) => render(template, data),
    // 行期片段（如会话开局的「运行环境」）：数据没有 agentKey / tools 那一套，故单独开一个口子
    renderPartial: (template, data) => render(template, data),
    templateNames: () => listTemplateNames(views),
  }
}

/** 列出模板目录下的 `.eta` 文件名（不含扩展名），仅用于诊断与测试 */
const listTemplateNames = (views: string): string[] => {
  try {
    return readdirSync(views)
      .filter((name) => name.endsWith('.eta'))
      .map((name) => name.slice(0, -'.eta'.length))
      .sort()
  } catch {
    // 模板目录缺失（部署时漏拷资产）时不要把诊断本身变成第二个错误
    return []
  }
}
