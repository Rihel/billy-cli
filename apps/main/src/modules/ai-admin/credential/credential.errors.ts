import { AppErrorCodes } from '@repo/shared'
import { AppError } from '@repo/kits'

/** 该 provider 没有可用模板（未收录 / 模板被改名） */
export class CredentialTemplateNotFoundError extends AppError {
  readonly code = AppErrorCodes.CredentialTemplateNotFound
  constructor(
    readonly provider: string,
    readonly template?: string,
  ) {
    super(`Credential template not found: ${template ?? provider}`)
  }
}

/** 字段值不符合模板（消息直接来自模板的中文校验提示，不含任何字段值） */
export class CredentialInvalidInputError extends AppError {
  readonly code = AppErrorCodes.CredentialInvalidInput
  constructor(readonly detail: string) {
    super(detail)
  }
}

/** 同一主体下凭据名已存在（覆盖是敏感操作，必须先由用户确认后再删旧建新） */
export class CredentialNameTakenError extends AppError {
  readonly code = AppErrorCodes.CredentialNameTaken
  constructor(readonly name: string) {
    super(`Credential name already taken: ${name}`)
  }
}

/** 未配置主密钥：可以启动，但**绝不能落明文**，因此写入直接失败 */
export class CredentialKeyNotConfiguredError extends AppError {
  readonly code = AppErrorCodes.CredentialKeyNotConfigured
  constructor() {
    super('Credential encryption key is not configured')
  }
}

/** 凭据不存在或不属于调用方（越权与不存在返回同一个错误，避免探测） */
export class CredentialNotFoundError extends AppError {
  readonly code = AppErrorCodes.CredentialNotFound
  constructor(readonly credentialId?: string) {
    super(`Credential not found${credentialId ? `: ${credentialId}` : ''}`)
  }
}
