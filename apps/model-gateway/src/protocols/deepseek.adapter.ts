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
 * - **请求带 `tools` 时**，历史里每条 assistant 消息都必须带 `reasoning_content`
 *   （官方文档：工具调用的后续请求「必须完整回传」，即使该轮没实际调用工具），
 *   否则上游回 400 `The reasoning_content in the thinking mode must be passed back to the API`。
 *
 * 判据只有一条：「**这次请求带没带 tools**」，与有没有传 `thinking` / `reasoning_effort`、
 * 模型名是否含 reasoner 都无关（2026-11-15 实测：不带 tools 时上游忽略该字段、不报错；
 * 带 tools 时缺字段必 400；补空串通过，thinking 显式关闭时补空串同样通过）。
 * 旧判据（thinking / reasoning_effort / 模型名）踩过坑：runtime 经网关调用**不发**这两个参数、
 * 模型名又是 `deepseek-flash`，三个条件全不中 → 整段跳过 → 工具调用续跑（以 tool 结果收尾）必 400。
 */
@Injectable()
export class DeepSeekAdapter implements ProtocolAdapter {
  readonly protocol: GatewayProtocol = AiProviderProtocol.Deepseek

  buildRequest(input: { body: GatewayChatBody; target: GatewayTarget }): UpstreamRequest {
    const request = buildOpenAiRequest(input)
    request.body = withDeepSeekReasoning(request.body as Record<string, unknown>)
    return request
  }
}

/** 请求是否携带工具（带 tools 就必须回放 reasoning_content） */
const carriesTools = (body: Record<string, unknown>): boolean =>
  Array.isArray(body.tools) && body.tools.length > 0

/** 给 assistant 历史消息补 `reasoning_content`（已有就原样保留，非 assistant 不动） */
export const withDeepSeekReasoning = (body: Record<string, unknown>): Record<string, unknown> => {
  if (!carriesTools(body)) return body
  const messages = body.messages
  if (!Array.isArray(messages)) return body
  return {
    ...body,
    messages: messages.map((message) => {
      const row = message as Record<string, unknown>
      if (row.role !== 'assistant' || 'reasoning_content' in row) return row
      return { ...row, reasoning_content: '' }
    }),
  }
}
