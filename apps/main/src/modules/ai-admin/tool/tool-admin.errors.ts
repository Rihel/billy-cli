import { AppError } from '@repo/kits'
import { AppErrorCodes } from '@repo/shared'

/** 工具不存在 / 未注册 / 运行时自带不可编辑（错误码 3407，与旧 `/ai-tool` 接口一致） */
export class ToolNotRegisteredError extends AppError {
  readonly code = AppErrorCodes.ToolNotRegistered
  constructor(readonly toolKey: string) {
    super(`工具不存在或未注册: ${toolKey}`)
  }
}

/** 配置值不合法（写入前过不了配置 / 秘钥定义，错误码 3408） */
export class ToolConfigInvalidError extends AppError {
  readonly code = AppErrorCodes.ToolConfigInvalid
  constructor(readonly reason: string) {
    super(`工具配置不合法: ${reason}`)
  }
}
