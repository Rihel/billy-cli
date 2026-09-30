import { describe, expect, it } from 'vitest'
import { CommandRunner } from '@repo/kits'
import { CommandCore } from '../src/modules/ai/core/command.core.js'
import { createPromptEngine } from '../src/modules/ai/prompts/index.js'
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
  const core = new CommandCore(
    new CommandRunner(),
    { commandEnabled: true, commandTimeoutMs: 5_000, commandMaxOutputBytes: 64 * 1024 } as never,
    { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
  )
  const tool = core.asTools().find((item) => item.key === 'run-command')
  if (!tool) throw new Error('没有 run-command 工具')
  return tool.description
}

describe('提示词纪律句（执行命令 / 能力边界 / 宽泛任务）', () => {
  const prompt = assistantPrompt()

  it('能力问题先验证：不许凭印象说"我做不到"（写在 run-command 的说明里）', () => {
    const description = runCommandDescription()
    expect(description).toContain('能力问题先验证')
    expect(description).toContain('"我做不到"必须有依据')
  })

  it('副作用与只读的边界写清楚：只读公开请求不必先问（写在 run-command 的说明里）', () => {
    // 早先这里写的是"任何往外部发的请求都要先问"，模型据此把一条只读 curl 也归进"要确认"，
    // 于是出现"我不会联网 / 我得先问你"这种看着很笨的回合
    const description = runCommandDescription()
    expect(description).toContain('只读的公开请求不必先问')
    expect(description).toContain('会改变外部状态')
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
})
