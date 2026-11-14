import type { RuleType } from '../../definitions/rule.types.js'
import { httpErrorRateRule } from './http-error-rate.rule.js'
import { httpErrorStreakRule } from './http-error-streak.rule.js'
import { httpP99Rule } from './http-p99.rule.js'
import { processMemoryRule } from './process-memory.rule.js'
import { uncaughtExceptionRule } from './uncaught-exception.rule.js'

export const SYSTEM_RULES: readonly RuleType[] = [
  httpErrorRateRule,
  httpErrorStreakRule,
  httpP99Rule,
  processMemoryRule,
  uncaughtExceptionRule,
]
