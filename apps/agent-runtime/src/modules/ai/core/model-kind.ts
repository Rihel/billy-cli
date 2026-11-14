import { AiProviderKind } from '@repo/shared'

/**
 * 有**官方 SDK 适配**的供应商类型（这些必须交给 `@ai-sdk/<provider>`，才能拿到各家私有字段）。
 *
 * 从原 `modules/ai-model/provider-adapters.ts` 收到 core：runtime 不再管"列模型/同步"，
 * 但**模型实例怎么造**仍需要这条判断（测试里的直连 mock 路径也走它）；生产路径由网关负责。
 *
 * 最典型的是**思考**：DeepSeek 的 `reasoning_content` 通用 OpenAI 兼容层不认，
 * 整段思考会被丢掉（踩过：前端"思考没显示"的根因之一）。
 */
export const OFFICIAL_ADAPTER_KINDS: ReadonlySet<string> = new Set([AiProviderKind.Deepseek])

export const usesOfficialAdapter = (kind: string | null | undefined): boolean =>
  kind ? OFFICIAL_ADAPTER_KINDS.has(kind) : false
