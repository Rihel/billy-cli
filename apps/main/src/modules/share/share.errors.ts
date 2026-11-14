import { AppErrorCodes } from '@repo/shared'
import { AppError } from '@repo/kits'

/**
 * 分享链路的错误。
 *
 * 对外的三种失败（查不到 / 已过期 / 已撤销 / 文件已删）**一律用 `ShareLinkInvalidError`** ——
 * 不给「链接存在但过期了」这类 oracle。
 */

/** token 无效：查不到 / 过期 / 撤销 / 文件已删，四合一 */
export class ShareLinkInvalidError extends AppError {
  readonly code = AppErrorCodes.ShareLinkInvalid
  constructor() {
    super('分享链接无效或已过期')
  }
}

/** 越权：别人会话的文件、或归属未知的文件 */
export class ShareForbiddenError extends AppError {
  readonly code = AppErrorCodes.ShareForbidden
  constructor() {
    super('无权分享该文件')
  }
}

/** 目标文件不存在（创建 / 列表时） */
export class ShareFileNotFoundError extends AppError {
  readonly code = AppErrorCodes.ShareFileNotFound
  constructor() {
    super('文件不存在或已删除')
  }
}

/** 过期时间不合法：用户自己填的时间不能早于当前时刻 */
export class ShareExpiryInvalidError extends AppError {
  readonly code = AppErrorCodes.ShareExpiryInvalid
  constructor() {
    super('过期时间必须晚于当前时间')
  }
}
