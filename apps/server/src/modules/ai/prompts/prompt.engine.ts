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
  /** 该 agent 被授权的工具（工具 key + 标题 + 说明，来自 ToolBuilder.describe） */
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
 * 渲染结果只做**首尾空行**清理：**不能**用 `dedent` —— 实测它会把提示词里
 * 「列表续行的 2 空格缩进」一起吃掉（`dedent('- 第一行\n  第二行续')` → 第二行缩进消失），
 * 而那段缩进在 Markdown 里是有意义的（续行属于同一个列表项）。
 * `dedent` 的用途是「代码里手写多行字符串」的场景（模板字面量的公共缩进），见下面的错误信息。
 *
 * 失败抛普通 `Error`（不是 `AppError`）：模板问题是**装配期**问题，应当在启动时炸出来，
 * 不需要走边界错误码映射。
 */
export interface PromptEngine {
  /** 渲染模板（不存在 / 语法错 → 抛错，错误信息带模板名与可用清单） */
  render: (template: string, data: PromptData) => string
  /** 全部可用模板名（诊断 / 测试用） */
  templateNames: () => string[]
}

export interface PromptEngineOptions {
  /** 模板目录；默认本文件同级的 `templates/`（dev 走 src，构建后走 dist，由 copy-assets 保证存在） */
  templatesDir?: string
}

/** 默认模板目录：`import.meta.dirname` 在 dev（tsx 直跑 src）与 prod（dist）下都指向本文件所在目录 */
const defaultTemplatesDir = (): string => join(import.meta.dirname, 'templates')

export const createPromptEngine = (options: PromptEngineOptions = {}): PromptEngine => {
  const views = options.templatesDir ?? defaultTemplatesDir()
  const eta = new Eta({ views, cache: true, autoEscape: false, tags: TEMPLATE_TAGS })

  return {
    render: (template, data) => {
      try {
        // 只清首尾空行，保留正文里的缩进（见上方注释：dedent 会吃掉列表续行缩进）
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
    },
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
