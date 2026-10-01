import { usesOfficialAdapter } from '../../ai-model/provider-adapters.js'
import { toAgentModelId, type AgentModelId } from './config.js'
import type { RuntimeModel } from './envelope.js'

/**
 * 「这一轮用哪个模型」的**纯决策**：把编排层解析出来的模型翻译成 Mastra 的模型对象，
 * 顺带定下"走官方 SDK 还是通用 OpenAI 兼容"。
 *
 * 为什么单独成文件（而不是留在 `ai.module.ts` 的工厂里）：
 * 这条决策有两个**踩过坑的硬约束**，它们必须能被单测直接锁住，别只靠人眼审阅
 * （`ai.module.ts` 的工厂要 `Mastra` 实例才能跑，很难单测）：
 *
 * 1. **官方适配不能传 `url`**：传了就被当成自定义兼容端点而走通用层 ——
 *    思考字段（DeepSeek 的 `reasoning_content`）整段消失；更糟的是此时 Mastra 的
 *    `agent.stream()` 返回的是**可恢复执行的工作流包装对象**（`{ output, fullStream, … }`），
 *    不是 `MastraModelOutput`，读取口径跟着变（见 `runtime/stream-result.ts`）；
 * 2. **判据是供应商类型（`kind`）不是 slug**：slug 是展示用的、人能改、还能撞名，
 *    用 slug 判断会让官方适配在"改个 slug"之后静默失效（踩过）。
 */

export interface ModelForMastra {
  id: AgentModelId
  /** 自定义兼容端点；**官方适配时一定没有这个字段**（传 url 会丢掉思考字段） */
  url?: string
  apiKey: string
}

export interface ModelForMastraDecision {
  model: ModelForMastra
  /** 走官方 SDK 适配（思考等私有字段才认得出来） */
  officialAdapter: boolean
  /**
   * 配了 `baseURL` 却因为走官方适配而被忽略（调用方据此**记一条 warn**，
   * 不静默吞掉用户的配置 —— 排障时"我明明配了地址"要有据可查）。
   */
  ignoredBaseURL?: string
}

/**
 * 决策：官方适配（`kind` 在名单里）→ 不传 `url`；其余 → 配了 `url` 就用它。
 *
 * `baseURL` 留空时天然也用 provider 自带端点，所以这两种情况的结果一致（都不传 url）。
 */
export const decideModelForMastra = (model: RuntimeModel): ModelForMastraDecision => {
  const officialAdapter = usesOfficialAdapter(model.providerKind)
  const ignoredBaseURL = officialAdapter ? model.baseURL : undefined
  return {
    model: {
      id: toAgentModelId(model.modelRef),
      ...(officialAdapter || !model.baseURL ? {} : { url: model.baseURL }),
      apiKey: model.apiKey,
    },
    officialAdapter,
    ...(ignoredBaseURL ? { ignoredBaseURL } : {}),
  }
}
