import { SANDBOX_CDN_HOSTS } from '@repo/shared'
import { describe, expect, it } from 'vitest'
import { TOOL_KEYS } from '../src/modules/ai/core/tools/tool-keys.js'
import { makeBashTool, specByKey } from './helpers/ai-tool-stack.js'
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
const bashDescription = (): string => {
  // 改造后工具组交的是**声明**（装饰器元数据 → `buildToolSpecs()`），说明文本就在声明上
  const group = makeBashTool({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  })
  return specByKey(group, TOOL_KEYS.bash).description
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
    // 2026-11-10 措辞调整：原文"不要原样重试" → "同一次调用原样重试没有意义"（语义不变）
    expect(prompt).toContain('同一次调用原样重试没有意义')
  })


  it('尽量用工具把事办成：一种方法不行就换第二种', () => {
    expect(prompt).toContain('尽量用工具把事办成')
    expect(prompt).toContain('换下一条')
    // 2026-11-10 措辞调整：原文"至少试两三种" → "换 2–3 种**不同的**路径"（语义不变）
    expect(prompt).toContain('换 2–3 种**不同的**路径')
    // 反面也钉住：不许只列能力限制再反问用户
    expect(prompt).toContain('不要只列一份"我的能力限制清单"')
  })

  /**
   * 技能**主动加载**（2026-11-11 真实会话 `eb01isgg2q4h53vh9aqs`）：
   * 用户要 HTML 调研报告，模型直接写了一版普通页面；直到用户说"用给你的 skill"才加载设计技能重做。
   * 这不是能力问题，是提示词没要求它先扫技能目录 —— 把"先加载再动手"钉住。
   */
  it('技能要主动加载：设计 / 页面类任务先 skill 再动手，不等用户点名', () => {
    expect(prompt).toContain('技能（主动加载，不要等用户点名）')
    expect(prompt).toContain('有匹配的就先用 `skill` 加载正文')
    expect(prompt).toContain('先加载设计 / 前端 / 排版类技能，再写第一版')
    expect(prompt).toContain('不要先交一版普通结果、等用户再来提醒才重做')
    // 具体对话里的原话不能进系统提示词（用户反馈：系统提示词里怎么还有测试例子的字眼）
    expect(prompt).not.toContain('用给你的 skill')
    // 富内容围栏里的纯文本层级示例也不能用真实测试内容（旧版写的是“决策层 / 行政：六部”）
    expect(prompt).not.toContain('行政：六部')
    expect(prompt).not.toContain('决策层')
  })

  /**
   * 联网的**选择顺序**（用户 2026-10-19 定）：默认先直取，搜索只作兜底。
   *
   * 为什么要钉：模型天然倾向"先搜一下"，而搜索按次计费、还多一层摘要损耗；
   * 有 URL / 接口地址时 `web-fetch` / `web-request` 更准。这条口径同时写在工具说明里，
   * 这里守提示词那一半 —— 只改一处会漂移。
   */
  it('联网优先直取：有 URL / 接口先用 web-fetch / web-request，搜索是兜底', () => {
    expect(prompt).toContain('联网优先直取')
    expect(prompt).toContain('只有确实不知道去哪找时')
    expect(prompt).toContain('搜到 URL 后仍回到 `web-fetch` 读正文')
  })

  it('宽泛任务先动手：不要把"能查的"也推回给用户', () => {
    expect(prompt).toContain('任务宽泛 / 意图不明时**先动手**')
  })

  /**
   * 页面预览的**第三方库**（2026-11-12）：写法搬进了内置技能 `html-page`，
   * 提示词只留「先加载技能 + 白名单」两件事 —— 细节每轮都付 token 不划算。
   *
   * 这里守的是**指针不许断**：技能名写错 / 漏了白名单，模型就会在没有依据的情况下写页面，
   * 而且页面空白时看不出是 CSP 拦的还是自己写错了。
   */
  it('页面预览：先加载 html-page 技能，并把 CDN 白名单写在提示词里', () => {
    const prompt = assistantPrompt()
    expect(prompt).toContain('`html-page`')
    expect(prompt).toContain('先加载')
    for (const host of SANDBOX_CDN_HOSTS) {
      expect(prompt).toContain(host)
    }
    // 白名单之外的域名要明确说加载不出来，否则模型会乱引 Google Fonts / cdnjs
    expect(prompt).toContain('一律加载不出来')
    // 具体写法在技能里，提示词里不该再重复（重复就是每轮白付一份 token）
    expect(prompt).not.toContain('document.write')
  })

  /**
   * 用户口径（2026-11-12）：**只要是写 HTML 都要先看这个技能** —— 不只是 `.html` 文件预览，
   * 聊天里的 `html` / `gsap` 围栏、页面里的 HTML / SVG 片段同样算。
   *
   * 所以这句话必须放在**无条件段**（「技能」段），不能塞在 `file-submit` 的 if 里：
   * 子 agent 没有文件工具，但也可能写围栏。
   */
  it('写 HTML 一律先加载 html-page：没有文件工具的 agent 也看得到这句', () => {
    const partial = createPromptEngine().renderPartial('partials/requirements', { tools: [] })
    expect(partial).toContain('`html-page`')
    expect(partial).toContain('写任何 HTML 之前先加载')
    expect(partial).toContain('`html` 围栏')
    expect(partial).toContain('`gsap` 动画围栏')
  })

  /**
   * `reason` 纪律（设计 §5.18）：**数据结构层面**是引擎注入的必填字段（标准测试集守着），
   * **行为层面**还要提示词说清"要如实填、不要写空话" —— 否则模型会填"为了完成任务"这种凑数的话。
   */
  it('调用理由要如实填：提示词里写明"每次调用都要先想清楚 reason"', () => {
    // 2026-11-10 措辞调整：`reason` 的写法从"每次调用"改成"每轮必填"，仍在"要求"段
    expect(prompt).toContain('`reason` 每轮必填')
    expect(prompt).toContain('也是审计证据')
  })
})
