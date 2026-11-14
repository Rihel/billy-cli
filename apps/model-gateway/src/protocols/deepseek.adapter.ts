import { Injectable } from '@nestjs/common'
import type { GatewayChatBody, GatewayProtocol } from '@repo/contracts'
import { AiProviderProtocol } from '@repo/shared'
import type { GatewayTarget } from '../catalog/model.catalog.service.js'
import { buildOpenAiRequest, type ProtocolAdapter, type UpstreamRequest } from './types.js'

/**
 * DeepSeek 官方协议（OpenAI 形状 + 思考字段约束）。
 *
 * 关键差异（踩过的坑，见 `docs/design/model-gateway.md` §3.7）：
 * - `reasoning_content` 必须**双向**保留（响应透传）；
 * - V4 / reasoner 在**思考模式下要求历史 assistant 消息也带 `reasoning_content`**，
 *   官方 SDK 用空串兜底；这里按「请求显式开了 thinking」或模型名含 reasoner 时补空串。
 */
@Injectable()
export class DeepSeekAdapter implements ProtocolAdapter {
  readonly protocol: GatewayProtocol = AiProviderProtocol.Deepseek

  buildRequest(input: { body: GatewayChatBody; target: GatewayTarget }): UpstreamRequest {
    const request = buildOpenAiRequest(input)
    request.body = withDeepSeekReasoning(
      request.body as Record<string, unknown>,
      input.target.entry.modelKey,
    )
    return request
  }
}

/** 是否处于「需要回放 reasoning_content」的场景 */
const needsReasoningHistory = (body: Record<string, unknown>, modelKey: string): boolean =>
  body.thinking !== undefined || body.reasoning_effort !== undefined || /reasoner/i.test(modelKey)

/** 给 assistant 历史消息补 `reasoning_content`（已有就原样保留） */
export const withDeepSeekReasoning = (
  body: Record<string, unknown>,
  modelKey: string,
): Record<string, unknown> => {
  const messages = body.messages
  if (!Array.isArray(messages) || !needsReasoningHistory(body, modelKey)) return body
  return {
    ...body,
    messages: messages.map((message) => {
      const row = message as Record<string, unknown>
      if (row.role !== 'assistant' || 'reasoning_content' in row) return row
      return { ...row, reasoning_content: '' }
    }),
  }
}
