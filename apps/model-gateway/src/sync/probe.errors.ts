import { AppError } from '@repo/kits'
import { AppErrorCodes } from '@repo/shared'

/** 供应商探测失败（列模型 / 连通性测试）；main 会映射成 3403 */
export class ProviderProbeFailedError extends AppError {
  readonly code = AppErrorCodes.ModelSyncFailed
  constructor(
    message: string,
    readonly endpoint = '',
  ) {
    super(message)
  }
}
