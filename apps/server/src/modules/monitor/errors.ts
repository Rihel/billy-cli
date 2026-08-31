import { AppErrorCodes } from '@repo/shared'
import { AppError } from '@repo/kits'

export class AlertRuleNotFoundError extends AppError {
  readonly code = AppErrorCodes.AlertRuleNotFound
  constructor(readonly ruleId: string) {
    super(`Alert rule not found: ${ruleId}`)
  }
}

export class AlertRuleNameTakenError extends AppError {
  readonly code = AppErrorCodes.AlertRuleNameTaken
  constructor(readonly name: string) {
    super(`Alert rule name already exists: ${name}`)
  }
}
