import _ from 'lodash'

export function isAvailableData(data: any): boolean {
  return !_.isNil(data) && data !== ''
}
export function hasContentArray(data: any): data is Array<any> {
  if (_.isNil(data)) return false
  return _.isArray(data) && !_.isEmpty(data)
}

export function isComplexData(data: any): data is Object | Array<any> {
  return _.isArray(data) || _.isObject(data)
}

export type CheckItem = RegExp | string
/**
 *
 * @param {CheckItem[]} checkList 检查规则，可以是字符串和正则
 * @param {string} str 检查的字符串
 * @returns {boolean} 检查结果
 */
export function checkIs<T extends CheckItem>(
  checkList: T[] = [],
  str: string = '',
): boolean {
  return checkList.some((item) => {
    if (typeof item === 'string') {
      return item === str
    }
    if (item instanceof RegExp) {
      return item.test(str)
    }
    return false
  })
}
