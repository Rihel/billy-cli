import { describe, expect, it } from 'vitest'
import {
  AgentChatResumeSchema,
  AgentChatSchema,
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_COUNT,
  ChatAttachmentSchema,
} from '../src/schema/agent.schema'

/**
 * 对话入参（含附件）的校验。
 *
 * 钉住的是**服务端的底线**：前端预检是体验，这里才是别人绕不过去的那道门 ——
 * 附件数量、单个大小、以及"空轮次"不许进来（让它到服务端才发现是白跑一轮）。
 */

const attachment = (partial: Record<string, unknown> = {}) => ({
  key: 'abc.png',
  filename: 'shot.png',
  mediaType: 'image/png',
  bytes: 1024,
  ...partial,
})

describe('ChatAttachmentSchema', () => {
  it('正常附件通过，只留 key 与元数据', () => {
    const parsed = ChatAttachmentSchema.parse(attachment())
    expect(parsed).toEqual(attachment())
  })

  it('单个超过 2MB → 拒绝', () => {
    const result = ChatAttachmentSchema.safeParse(
      attachment({ bytes: CHAT_ATTACHMENT_MAX_BYTES + 1 }),
    )
    expect(result.success).toBe(false)
  })

  it('key / 文件名 / 媒体类型不能为空（空串也是空）', () => {
    expect(ChatAttachmentSchema.safeParse(attachment({ key: '' })).success).toBe(false)
    expect(ChatAttachmentSchema.safeParse(attachment({ filename: '' })).success).toBe(false)
    expect(ChatAttachmentSchema.safeParse(attachment({ mediaType: '' })).success).toBe(false)
  })
})

describe('AgentChatSchema', () => {
  it('只有文字（不传 attachments）照旧可用 —— 老前端不该因为新字段被拒', () => {
    const result = AgentChatSchema.safeParse({ message: '你好' })
    expect(result.success).toBe(true)
    expect(result.data?.attachments).toBeUndefined()
  })

  it('只有附件、不打字也可用（拖一张图进来问"这是什么"就是这样）', () => {
    const result = AgentChatSchema.safeParse({ message: '', attachments: [attachment()] })
    expect(result.success).toBe(true)
  })

  it('**文字与附件同时为空 → 拒绝**（空轮次没有意义，别让服务端白跑一轮）', () => {
    expect(AgentChatSchema.safeParse({ message: '' }).success).toBe(false)
    expect(AgentChatSchema.safeParse({ message: '   ' }).success).toBe(false)
    expect(AgentChatSchema.safeParse({ message: '   ', attachments: [] }).success).toBe(false)
  })

  it(`附件数量上限是 ${CHAT_ATTACHMENT_MAX_COUNT} 个`, () => {
    const many = Array.from({ length: CHAT_ATTACHMENT_MAX_COUNT }, () => attachment())
    expect(AgentChatSchema.safeParse({ message: 'x', attachments: many }).success).toBe(true)
    expect(
      AgentChatSchema.safeParse({ message: 'x', attachments: [...many, attachment()] }).success,
    ).toBe(false)
  })

  it('会话 / agent / 模型三个可选标识照旧', () => {
    const result = AgentChatSchema.safeParse({
      conversationId: 'conv_1',
      agentKey: 'assistant',
      modelId: 'model_1',
      message: '你好',
      attachments: [attachment()],
    })
    expect(result.success).toBe(true)
  })
})


describe('AgentChatResumeSchema（回答 / 取消挂起）', () => {
  it('正常提交：answers 至少一条', () => {
    const parsed = AgentChatResumeSchema.safeParse({
      runId: 'run_1',
      toolCallId: 'call_1',
      answers: [{ id: 'q1', value: '长辈自己' }],
    })
    expect(parsed.success).toBe(true)
  })

  it('取消整组回答：cancelled=true 且不带 answers 也合法', () => {
    const parsed = AgentChatResumeSchema.safeParse({ runId: 'run_1', cancelled: true })
    expect(parsed.success).toBe(true)
  })

  it('既没答案也没取消 → 拒绝（空提交没有意义）', () => {
    expect(AgentChatResumeSchema.safeParse({ runId: 'run_1' }).success).toBe(false)
    expect(
      AgentChatResumeSchema.safeParse({ runId: 'run_1', answers: [] }).success,
    ).toBe(false)
  })
})
