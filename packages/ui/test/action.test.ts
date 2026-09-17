import { describe, expect, it, vi } from 'vitest'
import { callAction, defineAction } from '../src/action.ts'

describe('defineAction', () => {
  it('成功时返回 ok + data', async () => {
    const action = defineAction(async (input: { id: number }) => input.id * 2, {
      fallbackError: '失败',
    })

    await expect(action({ id: 21 })).resolves.toEqual({ ok: true, data: 42 })
  })

  it('失败时返回 ok:false + Error.message（不回抛）', async () => {
    const action = defineAction(
      async () => {
        throw new Error('邮箱已被占用')
      },
      { fallbackError: '注册失败' },
    )

    await expect(action(undefined)).resolves.toEqual({
      ok: false,
      error: '邮箱已被占用',
    })
  })

  it('非 Error 抛出时回落 fallbackError', async () => {
    const action = defineAction(
      async () => {
        throw '字符串异常'
      },
      { fallbackError: '操作失败' },
    )

    await expect(action(undefined)).resolves.toEqual({
      ok: false,
      error: '操作失败',
    })
  })

  it('getError 可自定义错误文案（优先于 Error.message）', async () => {
    const action = defineAction(
      async () => {
        throw new Error('ECONNREFUSED')
      },
      {
        fallbackError: '失败',
        getError: () => '服务暂时不可用，请稍后重试',
      },
    )

    await expect(action(undefined)).resolves.toEqual({
      ok: false,
      error: '服务暂时不可用，请稍后重试',
    })
  })

  it('失败时调用 onError 钩子（供服务端记日志）', async () => {
    const onError = vi.fn()
    const action = defineAction(
      async () => {
        throw new Error('boom')
      },
      { fallbackError: '失败', onError },
    )

    await action(undefined)

    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as Error).message).toBe('boom')
  })
})

describe('callAction', () => {
  const action = defineAction(
    async (input: { fail?: boolean }) => {
      if (input.fail) throw new Error('业务失败')
      return 'ok'
    },
    { fallbackError: '失败' },
  )

  it('成功时回调 onSuccess 并原样返回结果', async () => {
    const onSuccess = vi.fn()
    const onError = vi.fn()

    const result = await callAction(action, {}, { onSuccess, onError })

    expect(result).toEqual({ ok: true, data: 'ok' })
    expect(onSuccess).toHaveBeenCalledWith('ok')
    expect(onError).not.toHaveBeenCalled()
  })

  it('失败时回调 onError（传错误文案）且不回调 onSuccess', async () => {
    const onSuccess = vi.fn()
    const onError = vi.fn()

    const result = await callAction(action, { fail: true }, { onSuccess, onError })

    expect(result).toEqual({ ok: false, error: '业务失败' })
    expect(onError).toHaveBeenCalledWith('业务失败')
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('不传回调时也能安全调用', async () => {
    await expect(callAction(action, {})).resolves.toEqual({ ok: true, data: 'ok' })
  })
})
