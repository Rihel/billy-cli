import { createHash } from 'node:crypto'
import type { RuleType } from './rule.types.js'

/** 只把会影响行为的字段算进版本，字段展示文案变化不触发「定义已更新」 */
export function definitionVersion(rule: RuleType): string {
  const payload = {
    key: rule.key,
    kind: rule.kind,
    metricKey: rule.kind === 'metric' ? rule.metricKey : null,
    evaluationIntervalSeconds: rule.evaluationIntervalSeconds,
    windowSeconds: rule.windowSeconds,
    defaults: rule.defaults,
    fieldKeys: rule.fields.map((field) => field.key),
  }
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex')
}
