import _ from 'lodash'

export function sleep(time: number) {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve()
    }, time)
  })
}

type RetryOptions = {
  maxCount: number
  retryTime: number
}
/**
 * 创建一个重试函数，当传入的函数异常报错时，会重新调用，直到次数为止2
 * @param {Function} fn 重试函数
 * @param {Number} count 重试次数
 * @param {RetryOptions} options 重试配置
 * @returns
 */
export function createRetryFun<T extends (...args: any) => any>(
  fn: T,
  count?: number,
  options: RetryOptions = { maxCount: 10, retryTime: 1000 },
) {
  const { maxCount, retryTime } = options
  let _count = count
  let _error: Error | null = null
  async function _run(...args: Parameters<T>) {
    _count = Math.min(_count as number, maxCount)
    while (_count > 0) {
      try {
        return await fn?.(...args)
      } catch (error) {
        await sleep(retryTime)
        _count -= 1
        _error = error as Error
        continue
      }
    }
    throw _error
  }
  return async (...args: Parameters<T>) => {
    _count = count
    _error = null
    if (!_.isNil(_count) && _.isNumber(_count) && _count > 0) {
      return await _run(...args)
    }
    return await fn?.(...args)
  }
}

// 以16ms为间隔无限递归执行一次回调，直到超时为止
// 执行一个事情，但这事情依赖某个东西，这个东西是异步的，不确定啥时候拿的到
// 那么就给他个超时时间，超时或者拿到了就跳出无限递归
export const waitFor = async (
  timeout: number,
  cb?: () => boolean | Promise<boolean>,
) => {
  let seed = 0
  while (true) {
    seed += 16
    await sleep(16)
    const res = await cb?.()
    if (res === true || seed > timeout) {
      break
    }
  }
}
