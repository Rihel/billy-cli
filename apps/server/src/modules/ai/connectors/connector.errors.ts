import { AppError } from '@repo/kits'
import { AppErrorCodes } from '@repo/shared'

/** 连接器不存在（404） */
export class ConnectorNotFoundError extends AppError {
  readonly code = AppErrorCodes.ConnectorNotFound
  constructor(readonly connectorId: string) {
    super(`连接器不存在: ${connectorId}`)
  }
}

/** 连接器配置不合法（400）：驱动不存在、key 重复、缺必填字段… */
export class ConnectorConfigInvalidError extends AppError {
  readonly code = AppErrorCodes.ConnectorConfigInvalid
  constructor(readonly reason: string) {
    super(`连接器配置不合法: ${reason}`)
  }
}

/** 同步失败（409）：连不上 / 列不出工具 / key 冲突 */
export class ConnectorSyncFailedError extends AppError {
  readonly code = AppErrorCodes.ConnectorSyncFailed
  constructor(readonly reason: string) {
    super(`连接器同步失败: ${reason}`)
  }
}
