import { describe, expect, it } from 'vitest'
import type { CreateLoggerResult } from '@repo/shared/logger'
import { AppLogger } from '../src/foundation/logger/app-logger.js'
import { NestLoggerAdapter } from '../src/foundation/logger/nest-logger.js'

interface Call {
  level: string
  context: string
  message?: string
  data?: unknown
}

/** 宿主类实例（AppLogger 取的是 `instance.constructor.name`） */
class Foo {}

/**
 * 假的基础日志门面：记录「哪个 context 的哪条日志」，不碰真实 pino。
 *
 * 这样测的是 AppLogger / NestLoggerAdapter 自身的逻辑（context、meta 归置、参数约定），
 * 而不是 pino 的输出格式。`setContext` 按真实实现语义切换 context（真实实现会 derive child）。
 */
const makeFakeBase = () => {
  const calls: Call[] = []
  const childContexts: string[] = []

  const make = (initialContext: string): CreateLoggerResult => {
    let context = initialContext
    const record = (level: string) => (message?: string, data?: unknown) => {
      calls.push({ level, context, message, data })
    }
    return {
      setContext: (next: string) => {
        context = next
      },
      child: (next: string) => {
        childContexts.push(next)
        return make(next)
      },
      log: record('info'),
      info: record('info'),
      warn: record('warn'),
      debug: record('debug'),
      error: record('error'),
    }
  }

  return { base: make(''), calls, childContexts }
}

describe('AppLogger（注入式业务日志）', () => {
  it('context 自动取宿主类名（INQUIRER 语义）', () => {
    const { base, calls, childContexts } = makeFakeBase()
    class TodoService {}
    const logger = new AppLogger(new TodoService(), base)

    logger.info('创建待办')

    expect(childContexts).toEqual(['TodoService'])
    expect(calls[0]).toMatchObject({
      level: 'info',
      context: 'TodoService',
      message: '创建待办',
    })
  })

  it('宿主类拿不到时回落 App', () => {
    const { base, childContexts } = makeFakeBase()
    new AppLogger(undefined as unknown as object, base)
    expect(childContexts).toEqual(['App'])
  })

  it('plain object 的 data 并入结构化字段，并带上 context', () => {
    const { base, calls } = makeFakeBase()
    const logger = new AppLogger(new Foo(), base)

    logger.info('已注册任务', { name: 'job', intervalMs: 1000 })

    expect(calls[0].data).toMatchObject({ context: 'Foo', intervalMs: 1000 })
    // name 是 pino 保留字段 → 收进 data 子对象，避免覆盖 logger name
    expect(calls[0].data).toMatchObject({ data: { name: 'job' } })
  })

  it('非对象 data 收进 data 字段', () => {
    const { base, calls } = makeFakeBase()
    const logger = new AppLogger(new Foo(), base)

    logger.warn('异常值', 'plain-string')

    expect(calls[0]).toMatchObject({ level: 'warn' })
    expect(calls[0].data).toMatchObject({ data: 'plain-string' })
  })

  it('log 等价 info；setContext 覆盖 context', () => {
    const { base, calls } = makeFakeBase()
    const logger = new AppLogger(new Foo(), base)

    logger.log('兼容调用')
    logger.setContext('HTTP')
    logger.error('失败', { status: 500 })

    expect(calls[0].level).toBe('info')
    expect(calls[1]).toMatchObject({ level: 'error', context: 'HTTP' })
    expect(calls[1].data).toMatchObject({ context: 'HTTP', status: 500 })
  })
})

describe('NestLoggerAdapter（Nest 框架日志适配）', () => {
  it('最后一个字符串参数视为 context', () => {
    const { base, calls, childContexts } = makeFakeBase()
    const adapter = new NestLoggerAdapter(base)

    adapter.log('Mapped {/todo, POST} route', 'RouterExplorer')

    expect(childContexts).toEqual(['RouterExplorer'])
    expect(calls[0]).toMatchObject({
      level: 'info',
      context: 'RouterExplorer',
      message: 'Mapped {/todo, POST} route',
    })
  })

  it('同一 context 复用 child（缓存）', () => {
    const { base, childContexts } = makeFakeBase()
    const adapter = new NestLoggerAdapter(base)

    adapter.log('a', 'InstanceLoader')
    adapter.log('b', 'InstanceLoader')

    expect(childContexts).toEqual(['InstanceLoader'])
  })

  it('Error 取 message，堆栈作为附加参数带上', () => {
    const { base, calls } = makeFakeBase()
    const adapter = new NestLoggerAdapter(base)

    adapter.error(new Error('boom'), 'bootstrap')

    expect(calls[0]).toMatchObject({
      level: 'error',
      context: 'bootstrap',
      message: 'boom',
    })
    const params = (calls[0].data as { params: unknown[] }).params
    expect(params.some((p) => typeof p === 'string' && p.includes('boom'))).toBe(true)
  })

  it('非 Error 的 message 原样转字符串；verbose 归到 debug', () => {
    const { base, calls } = makeFakeBase()
    const adapter = new NestLoggerAdapter(base)

    adapter.log(42, 'NestApplication')
    adapter.verbose('细节', 'Bootstrap')

    expect(calls[0]).toMatchObject({ message: '42', context: 'NestApplication' })
    expect(calls[1]).toMatchObject({ level: 'debug', context: 'Bootstrap' })
  })

  it('未给 context 时回落 Nest', () => {
    const { base, calls } = makeFakeBase()
    const adapter = new NestLoggerAdapter(base)

    adapter.warn('无上下文')

    expect(calls[0].context).toBe('Nest')
  })
})
