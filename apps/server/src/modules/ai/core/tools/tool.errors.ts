import { AppError } from '@repo/kits'
import { AppErrorCodes } from '@repo/shared'

/** 工具不存在或未注册（配置接口用的错误码，见设计 §5.5） */
export class ToolNotRegisteredError extends AppError {
  readonly code = AppErrorCodes.ToolNotRegistered
  constructor(readonly toolKey: string) {
    super(`工具不存在或未注册: ${toolKey}`)
  }
}

/** 配置值不合法（写入前过不了 `spec.config` / `spec.secrets`） */
export class ToolConfigInvalidError extends AppError {
  readonly code = AppErrorCodes.ToolConfigInvalid
  constructor(readonly reason: string) {
    super(`工具配置不合法: ${reason}`)
  }
}
