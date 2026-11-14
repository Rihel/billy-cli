import { AppErrorCodes } from '@repo/shared'
import { AppError } from '@repo/kits'

/** 文件 key 非法（空 / 过滤后为空 / 含非法字符） */
export class StorageKeyInvalidError extends AppError {
  readonly code = AppErrorCodes.StorageKeyInvalid
  constructor(readonly key: string) {
    super(`非法文件 key: ${key}`)
  }
}

/** 越界访问：前台用户只能操作自己命名空间（`user/{userId}/`）内的对象 */
export class StorageKeyForbiddenError extends AppError {
  readonly code = AppErrorCodes.StorageKeyForbidden
  constructor(readonly key: string) {
    super(`无权访问该文件: ${key}`)
  }
}

/** STS 临时凭证仅限管理员（整桶权限，不做前缀限定不发放给前台） */
export class StorageAdminOnlyError extends AppError {
  readonly code = AppErrorCodes.StorageAdminOnly
  constructor() {
    super('该存储操作仅限管理员')
  }
}
