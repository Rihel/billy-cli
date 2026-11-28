import { Inject, Injectable, Optional } from '@nestjs/common'
import { estimateContentTokens } from '@repo/shared'
import {
  ChatAttachmentService,
  withUserContent,
} from '../../runtime/attachments/chat-attachment.service.js'
import { ContextService } from '../../runtime/context/context.service.js'
import type {
  ContextAssembleInput,
  ContextAssembleResult,
  ContextAssembler,
  MemoryPort,
} from '../ports.js'
import { MEMORY_PORT } from '../tokens.js'

/**
 * 上下文接缝适配器：把「附件多模态 + 长期记忆 + 裁剪/压缩预算」合成一次组装。
 *
 * 行为与原先 `AgentChatService.buildContext` 逐字节一致：附件服务先按存储 key
 * 读回内容（归属校验在读之前），记忆按用户 + agent 查注入块，最后交给 ContextService
 * 做窗口判定与裁剪。
 */
@Injectable()
export class ContextAssemblerAdapter implements ContextAssembler {
  constructor(
    @Inject(ContextService) private readonly context: ContextService,
    @Inject(ChatAttachmentService) private readonly attachments: ChatAttachmentService,
    @Inject(MEMORY_PORT) @Optional() private readonly memory?: MemoryPort | null,
  ) {}

  async assemble(input: ContextAssembleInput): Promise<ContextAssembleResult> {
    const hasAttachments = Boolean(input.attachments && input.attachments.length > 0)
    const userContent = hasAttachments
      ? await this.attachments.buildUserContent(
          input.userMessage,
          input.attachments,
          input.inputModalities,
        )
      : null
    const memoryBlock = this.memory ? await this.memory.recall(input.userId, input.agentKey) : null

    const built = await this.context.buildInput({
      conversationId: input.conversationId,
      modelId: input.modelId,
      systemPrompt: input.systemPrompt,
      userMessage: input.userMessage,
      ...(input.windowTokens ? { windowTokens: input.windowTokens } : {}),
      ...(userContent ? { extraInputTokens: estimateContentTokens(userContent) } : {}),
      ...(memoryBlock ? { memory: memoryBlock } : {}),
      ...(input.internalNotice ? { internalNotice: input.internalNotice } : {}),
    })

    if (!userContent) return built
    return { ...built, messages: withUserContent(built.messages, userContent) }
  }
}
