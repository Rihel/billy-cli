import { describe, expect, it } from 'vitest'
import '../src/index.js'
import { AppContext } from '../src/app-context.js'
import { DiParamTypesKey, Inject, Injectable } from '../src/di.js'
import type { OnAppStart, OnAppStop } from '../src/life-cycle.js'

describe('@repo/di AppContext', () => {
  it('Injectable + Inject：构造器注入解析', () => {
    @Injectable()
    class Db {}
    @Injectable()
    class Service {
      constructor(@Inject(Db) readonly db: Db) {}
    }

    const ctx = new AppContext().addService(Service).addService(Db)
    const service = ctx.get(Service)
    expect(service).toBeInstanceOf(Service)
    expect(service.db).toBeInstanceOf(Db)
  })

  it('addConstant：token 绑定常量值', () => {
    const cfg = { port: 9989 }
    const ctx = new AppContext().addConstant('CFG', cfg)
    expect(ctx.get('CFG')).toBe(cfg)
  })

  it('单例与瞬时作用域', () => {
    @Injectable()
    class Singleton {}
    @Injectable()
    class Transient {}

    const ctx = new AppContext()
      .addService(Singleton)
      .addTransient(Transient)
    expect(ctx.get(Singleton)).toBe(ctx.get(Singleton))
    expect(ctx.get(Transient)).not.toBe(ctx.get(Transient))
  })

  it('start 之前也能 get（惰性绑定）', () => {
    @Injectable()
    class Service {}

    const ctx = new AppContext().addService(Service)
    expect(ctx.get(Service)).toBeInstanceOf(Service)
  })

  it('生命周期：依赖先启动、逆序停止', async () => {
    const events: string[] = []

    @Injectable()
    class A implements OnAppStart, OnAppStop {
      async onAppStart() { events.push('A.start') }
      async onAppStop() { events.push('A.stop') }
    }
    @Injectable()
    class B implements OnAppStart, OnAppStop {
      constructor(@Inject(A) readonly a: A) {}
      async onAppStart() { events.push('B.start') }
      async onAppStop() { events.push('B.stop') }
    }
    @Injectable()
    class C implements OnAppStart, OnAppStop {
      constructor(@Inject(B) readonly b: B) {}
      async onAppStart() { events.push('C.start') }
      async onAppStop() { events.push('C.stop') }
    }

    // 乱序注册，宿主仍保证依赖先启动
    const ctx = new AppContext()
      .addLifeCycleService(C)
      .addLifeCycleService(A)
      .addLifeCycleService(B)

    expect(ctx.getState()).toBe('idle')
    await ctx.start()
    expect(ctx.getState()).toBe('started')
    expect(events).toEqual(['A.start', 'B.start', 'C.start'])

    await ctx.stop()
    expect(ctx.getState()).toBe('stopped')
    expect(events).toEqual(['A.start', 'B.start', 'C.start', 'C.stop', 'B.stop', 'A.stop'])
  })

  it('生命周期：start/stop 幂等', async () => {
    @Injectable()
    class A implements OnAppStart {
      starts = 0
      async onAppStart() { this.starts += 1 }
    }

    const ctx = new AppContext().addLifeCycleService(A)
    await ctx.start()
    await ctx.start()
    await ctx.stop()
    await ctx.stop()
    expect(ctx.get(A).starts).toBe(1)
    expect(ctx.getState()).toBe('stopped')
  })

  it('生命周期：依赖存在环时抛错且状态回滚', async () => {
    @Injectable()
    class A implements OnAppStart {
      async onAppStart() {}
    }
    @Injectable()
    class B implements OnAppStart {
      async onAppStart() {}
    }
    // 类无法用 @Inject 表达互相引用（装饰器求值时后者尚未定义，TDZ），
    // 直接写入等价元数据来构造环，测 LifeCycleHost 的环检测。
    Reflect.defineMetadata(DiParamTypesKey, [B], A)
    Reflect.defineMetadata(DiParamTypesKey, [A], B)

    const ctx = new AppContext()
      .addLifeCycleService(A)
      .addLifeCycleService(B)
    await expect(ctx.start()).rejects.toThrow(/依赖存在环/)
    expect(ctx.getState()).toBe('idle')
  })
})
