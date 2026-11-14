import { AppErrorCodes } from '@repo/shared'
import { AppError } from '@repo/kits'

export class MonitorRuleNotFoundError extends AppError {
  readonly code = AppErrorCodes.MonitorRuleNotFound
  constructor(readonly ruleKey: string) {
    super(`Monitor rule not found: ${ruleKey}`)
  }
}

export class MonitorRuleConfigInvalidError extends AppError {
  readonly code = AppErrorCodes.MonitorRuleConfigInvalid
  constructor(readonly detail: string) {
    super(`Monitor rule config invalid: ${detail}`)
  }
}

export class MonitorMetricNotFoundError extends AppError {
  readonly code = AppErrorCodes.MonitorMetricNotFound
  constructor(readonly metricKey: string) {
    super(`Monitor metric not found: ${metricKey}`)
  }
}

export class MonitorAlertNotFoundError extends AppError {
  readonly code = AppErrorCodes.MonitorAlertNotFound
  constructor(readonly alertId: string) {
    super(`Monitor alert not found: ${alertId}`)
  }
}
