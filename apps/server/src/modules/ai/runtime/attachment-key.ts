import { Injectable } from '@nestjs/common'
import { AppError } from '@repo/kits'
import { AppErrorCodes } from '@repo/shared'
import { requestContext } from '../../../common/index.js'

/**
 * 对话附件的**存储 key 归属校验**。
 *
 * ## 为什么必须单独有这一层
 *
 * 附件链路是「前端直传对象存储 → 只把 key 交给服务端 → 服务端按 key 取回内容喂给模型」。
 * 这里的 key 是**客户端给的**：不校验的话，前台用户把 key 写成 `user/<别人的 id>/x.png`，
 * 服务端就会去把别人的文件读出来（内容还会经模型回显给他）—— 一条完整的越权读取。
 * 上传时服务端会把 key 改写到自己的命名空间（`resolveUploadKey`），但**上传改写挡不住伪造的提交**。
 *
 * ## 判据与存储模块一致（刻意复用，不另写一套）
 *
 * - **前台用户**（有 `userId`）：key 必须落在 `user/<自己的 id>/` 下，否则 403；
 * - **管理员**（只有 `adminId`）：按现状放行（管理员在后台上传时不加前缀，见 `resolveUploadKey`），
 *   且前台用户读不到管理员的文件（想读就得伪造 `user/<自己 id>/` 前缀，那指向的是自己的目录）；
 * - **鉴权关闭**（两个身份都没有）：按现状放行，与 `StorageController` 的姿态一致。
 */
@Injectable()
export class AttachmentKeyPolicy {
  /** 当前请求的身份（与 `StorageController.identity` 同一口径：直接读 ALS，缺就是没有） */
  private identity(): { userId?: string; adminId?: string } {
    return {
      userId: requestContext.get('userId') ?? undefined,
      adminId: requestContext.get('adminId') ?? undefined,
    }
  }

  /**
   * 校验这批 key 都归当前身份所有（不通过就抛，**不静默跳过那条附件** ——
   * 静默跳过会让模型对着一份看不见的附件胡说，而用户以为它读过了）。
   */
  assertOwned(keys: readonly string[]): void {
    const { userId, adminId } = this.identity()
    // 管理员与无身份放行（与存储模块的下载策略同一姿态）
    if (!userId || adminId) return

    const prefix = `user/${userId}/`
    for (const key of keys) {
      const raw = key?.trim() ?? ''
      if (!raw) throw new AttachmentKeyForbiddenError(key ?? '')
      if (!raw.startsWith(prefix)) throw new AttachmentKeyForbiddenError(raw)
    }
  }
}

/**
 * 附件 key 不属于当前用户。
 *
 * 刻意**说得含糊**（"无权访问"而不区分"不存在 / 不是你的"）：与 `ConversationNotFoundError` 同一考虑 ——
 * 明确的区分会被用来探测别人的对象是否存在。
 */
export class AttachmentKeyForbiddenError extends AppError {
  readonly code = AppErrorCodes.StorageKeyForbidden
  constructor(readonly key: string) {
    super(`无权访问该附件: ${key}`)
  }
}
