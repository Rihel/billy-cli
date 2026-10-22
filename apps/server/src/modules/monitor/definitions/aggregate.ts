export type Aggregation = 'last' | 'sum' | 'avg' | 'max'

/** 把一组值按规则配置归并成一个值；空数组返回 0 */
export function aggregate(values: readonly number[], mode: Aggregation): number {
  if (values.length === 0) return 0
  switch (mode) {
    case 'sum':
      return values.reduce((total, value) => total + value, 0)
    case 'avg':
      return values.reduce((total, value) => total + value, 0) / values.length
    case 'max':
      return Math.max(...values)
    case 'last':
    default:
      return values[0]
  }
}
