import _ from 'lodash'

export function mapValue<T extends Record<string, any>>(
  map: T,
  defaultValue?: any,
) {
  return (key: keyof T | string): T[keyof T] => {
    const value = map[key]
    return _.isNil(value) ? defaultValue : value
  }
}

export function mapFun<T extends Record<string, (...args: any) => any>>(
  map: T,
) {
  return (
    key: keyof T,
    ...args: Parameters<T[keyof T]>
  ): ReturnType<T[keyof T]> => {
    return map[key]?.(...args)
  }
}

export function funWrap(data: any) {
  return () => data
}

export type MaybeFunction<Value, Args extends unknown[] = []> =
  | Value
  | ((...args: Args) => Value)

export function maybeFun<Value, Args extends unknown[]>(
  data: MaybeFunction<Value, Args>,
  ...args: Args
): Value {
  if (typeof data === 'function') {
    return (data as (...args: Args) => Value)(...args)
  }
  return data
}

export const getDataType = (value: string) => {
  const res = Object.prototype.toString.call(value)
  const match = res.toLowerCase().match(/\[object (.+)\]/)

  return match?.[1] as string | undefined
}

/**
 * 通过优先级取值, 根据数组下标确定优先级，第一个优先级最高，最低一个优先级最低
 * 如果 下标数据 为null或undefined，则取下一个
 */
export function getDataByPriority(arr: any[] = [], log = false) {
  let value
  let i = 0
  while (!_.isEmpty(arr)) {
    value = arr.shift()

    if (log) {
      console.log(i, value)
    }
    i++
    if (!_.isNil(value)) {
      break
    }
  }
  return value
}

type Big = 'big'
export function createBreakpoints<T extends Record<string, number>>(data: T) {
  const breakpoints = _.chain(data).entries().orderBy('1', 'asc').value()
  // @ts-ignore
  const res: Record<keyof T | Big, [number, number]> = {}

  if (breakpoints.length === 1) {
    const [key, value] = breakpoints[0] as [keyof T | Big, number]
    res[key] = [0, value]
    res['big'] = [value, Infinity]
    return res
  }

  for (let i = 0; i < breakpoints.length; i++) {
    const [key, value] = breakpoints[i] as [keyof T | Big, number]

    if (i === 0) {
      res[key] = [0, value]
    } else if (i === breakpoints.length - 1) {
      res[key] = [value, Infinity]
    } else {
      res[key] = [breakpoints[i - 1][1], value]
    }
  }
  return res
}

export type MergeRule<T extends Record<string, any>, K extends keyof T> = (
  sourceValue: T[K],
  propsValue: T[K],
) => T[K]
export function mergeWith<
  T extends Record<string, any> = Record<string, any>,
  K extends keyof T = keyof T,
  Rule extends MergeRule<T, K> = MergeRule<T, K>,
>(source: T, target: Partial<T>, mergeRules: Record<K, Rule>): Partial<T> {
  return Object.entries(mergeRules).reduce<Partial<T>>(
    (acc, [field, mergeRule]) => {
      const sourceValue = source[field] as T[K]
      const targetValue = target[field] as T[K]
      let value = (mergeRule as Rule)(sourceValue, targetValue)

      acc[field as K] = value
      return acc
    },
    {} as Partial<T>,
  )
}

export function parseJson<T>(
  jsonString: string,
  defaultValue: T,
  onError?: (error: unknown) => void,
): T
export function parseJson<T = unknown>(
  jsonString: string,
  defaultValue?: undefined,
  onError?: (error: unknown) => void,
): T | undefined
export function parseJson(
  jsonString: string,
  defaultValue?: any,
  onError?: (error: unknown) => void,
) {
  try {
    return JSON.parse(jsonString)
  } catch (error) {
    onError?.(error)
    return defaultValue
  }
}

export const normalizeArray = <T>(arr: T | T[]) => {
  if (Array.isArray(arr)) {
    return arr
  }
  return [arr] as T[]
}

export const maybePromise = async <T>(data: T | PromiseLike<T>): Promise<T> =>
  await data
