import type { AppLogger, ObjectStorage } from '@repo/kits'
import { AttachmentKeyPolicy } from '../../src/modules/ai/runtime/attachment-key.js'
import { ChatAttachmentService } from '../../src/modules/ai/runtime/chat-attachment.service.js'

/**
 * 端到端测试里的**附件替身**。
 *
 * 为什么需要它：`AgentChatService` 的构造器是**位置参数**（16 个），多一个依赖就多一个位置 ——
 * 漏给会让后面所有参数整体错位，症状是"logger 不是函数"这类与真实原因毫不相干的报错
 * （踩过一次：`streamStore` 位置被顶成了 logger，全程只有一句 `this.logger.error is not a function`）。
 *
 * 对象存储替身返回一份**固定的 PNG 字节**：不带附件的用例根本不会读它；
 * 带附件的用例（如"图片真的到了模型请求里"）就能拿同一份字节去断言 data URL。
 */
export const STUB_IMAGE_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])

export const stubAttachments = (logger: AppLogger): ChatAttachmentService =>
  new ChatAttachmentService(
    {
      getObject: async ({ key }: { key: string }) => ({ key, body: STUB_IMAGE_BYTES }),
    } as unknown as ObjectStorage,
    // 归属校验：e2e 的请求上下文里没有登录身份（用的是 `setAuditUserProvider`），
    // 策略因此按"鉴权关闭"放行 —— 归属校验本身由 `ai-chat-attachment.test.ts` 专门钉住
    new AttachmentKeyPolicy(),
    logger,
  )
