import { AppError } from '@repo/kits'
import { AppErrorCodes } from '@repo/shared'

/**
 * 连接器控制面错误（错误码沿用 `AppErrorCodes` 里已定义的 3409 / 3410）。
 *
 * 只是 HTTP 边界的语义：404 = 实例不存在，400 = 配置或型号不合法。
 * 同步 / 探活失败**不抛错**（同步是异步通知，结论由 runtime 写回
 * `status` / `last_error`；探活结论走 `AiConnectorActionResult`）。
 */
export class ConnectorNotFoundError extends AppError {
  readonly code = AppErrorCodes.ConnectorNotFound
  constructor(readonly connectorId: string) {
    super(`连接器不存在: ${connectorId}`)
  }
}

/** 配置不合法（400）：未知型号 / 驱动不匹配 / key 重复 / 缺必填密钥… */
export class ConnectorConfigInvalidError extends AppError {
  readonly code = AppErrorCodes.ConnectorConfigInvalid
  constructor(readonly reason: string) {
    super(`连接器配置不合法: ${reason}`)
  }
}
