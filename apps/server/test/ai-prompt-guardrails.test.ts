import { describe, expect, it } from 'vitest'
import { CommandRunner } from '@repo/kits'
import { RunCommandTool } from '../src/modules/ai/tools/command.tool.js'
import { TOOL_KEYS } from '../src/modules/ai/core/tools/tool-keys.js'
import { specByKey } from './helpers/ai-tool-stack.js'
import { createPromptEngine } from '../src/modules/ai/core/prompts/index.js'
import { DEFAULT_AGENT_KEY, createAgentDefinitions } from '../src/modules/ai/agents/index.js'

/**
 * 提示词**纪律句**的守卫。
 *
 * 为什么要给它写测试：这些规则是从**真实对话的翻车**里长出来的（用户反馈"怎么感觉笨笨的"），
 * 但它们只是模板里的一段文字 —— 改模板时最容易顺手删掉，删完没有任何东西会红。
 * 这里把"必须存在的那几条"钉住：措辞可以再打磨，**语义不能丢**。
 */
const assistantPrompt = (): string => {
  const definitions = createAgentDefinitions(createPromptEngine(), {
    describe: (keys: readonly string[]) =>
      keys.map((key) => ({ key, title: key, description: key })),
  } as never)
  const assistant = definitions.find((definition) => definition.key === DEFAULT_AGENT_KEY)
  if (!assistant) throw new Error('没有找到默认 agent 的定义')
  return assistant.instructions
}

/**
 * 工具自己的说明（= 系统提示词「工具」段渲染的那份，也是模型选工具时看到的定义）。
 *
 * ⚠️ 纪律句的位置：**工具专属的纪律写在工具的 `description` 里**（一个工具只写一处），
 * 所以这里直接查那份说明 —— 不再从提示词模板里找（模板里已经不重复写了）。
 */
const runCommandDescription = (): string => {
  // 改造后工具组交的是**声明**（装饰器元数据 → `buildToolSpecs()`），说明文本就在声明上
  const group = new RunCommandTool(new CommandRunner(), {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as never)
  return specByKey(group, TOOL_KEYS.runCommand).description
}

describe('提示词纪律句（执行命令 / 能力边界 / 宽泛任务）', () => {
  const prompt = assistantPrompt()

  /**
   * 这三条**共性纪律写在全局段**（`partials/principles.eta` 的「纪律（所有工具通用）」），
   * 不再逐个工具重复 —— 每个工具的说明只留它自己特有的边界。
   *
   * 为什么改：纪律是**跨工具**的，写在每个工具说明里等于按工具数重复付 token；
   * 参考 DSH 自己的系统提示词（规则集中写一遍、工具只留一句）。
   */
  it('能力问题先验证：不许凭印象说"我做不到"（写在全局纪律段）', () => {
    expect(prompt).toContain('不确定就先验证')
    expect(prompt).toContain('"我做不到"必须有依据')
  })

  it('副作用与只读的边界写清楚：只读公开请求不必先问（写在全局纪律段）', () => {
    // 早先这里写的是"任何往外部发的请求都要先问"，模型据此把一条只读 curl 也归进"要确认"，
    // 于是出现"我不会联网 / 我得先问你"这种看着很笨的回合
    expect(prompt).toContain('只读的公开请求不必先问')
    expect(prompt).toContain('会改变外部状态')
  })

  it('失败处理写在全局纪律段：读懂原因、不要原样重试', () => {
    expect(prompt).toContain('失败是结论不是意外')
    expect(prompt).toContain('不要原样重试')
  })


  it('尽量用工具把事办成：一种方法不行就换第二种', () => {
    expect(prompt).toContain('尽量用工具把事办成')
    expect(prompt).toContain('换下一条')
    expect(prompt).toContain('至少试两三种')
    // 反面也钉住：不许只列能力限制再反问用户
    expect(prompt).toContain('不要只列一份"我的能力限制清单"')
  })

  it('宽泛任务先动手：不要把"能查的"也推回给用户', () => {
    expect(prompt).toContain('任务宽泛 / 意图不明时**先动手**')
  })

  /**
   * `reason` 纪律（设计 §5.18）：**契约层面**是引擎注入的必填字段（标准测试集守着），
   * **行为层面**还要提示词说清"要如实填、不要写空话" —— 否则模型会填"为了完成任务"这种凑数的话。
   */
  it('调用理由要如实填：提示词里写明"每次调用都要先想清楚 reason"', () => {
    expect(prompt).toContain('每次调用工具都要先想清楚 `reason` 再填')
    expect(prompt).toContain('它是审计证据')
  })
})
