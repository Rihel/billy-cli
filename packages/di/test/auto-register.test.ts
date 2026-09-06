import { describe, expect, it } from 'vitest'
import '../src/index.js'
import { AppContext } from '../src/app-context.js'
import { Inject, Injectable } from '../src/di.js'
import type { OnAppStart, OnAppStop } from '../src/life-cycle.js'

/**
 * autoRegister 自动装配测试（独立文件：vitest 每文件独立模块实例，注册表干净）。
 *
 * 类定义在文件顶层 → 模块加载时 @Injectable 装饰器执行并登记；
 * 每个用例各自 new AppContext()，注册表对所有用例内容一致，行为可预测。
 */

@Injectable()
class PlainRepo {}

@Injectable()
class PlainService {
  constructor(@Inject(PlainRepo) readonly repo: PlainRepo) {}
}

@Injectable()
class ManualBean {}

@Injectable()
class LifeCycleBean implements OnAppStart, OnAppStop {
  readonly events: string[] = []
  async onAppStart() { this.events.push('start') }
  async onAppStop() { this.events.push('stop') }
}

@Injectable()
class LifeCycleWithDep implements OnAppStart {
  constructor(@Inject(LifeCycleBean) readonly dep: LifeCycleBean) {}
  async onAppStart() {}
}

describe('@repo/di autoRegister', () => {
  it('自动装配 @Injectable 登记的类（含构造器依赖解析、单例）', () => {
    const ctx = new AppContext().autoRegister()
    const service = ctx.get(PlainService)
    expect(service).toBeInstanceOf(PlainService)
    expect(service.repo).toBeInstanceOf(PlainRepo)
    // 单例：两次获取同一实例
    expect(ctx.get(PlainService)).toBe(service)
  })

  it('markManual 声明的类被跳过（不自动装配）', () => {
    const ctx = new AppContext().markManual(ManualBean).autoRegister()
    // 手动管理的类未装配：解析应报错
    expect(() => ctx.get(ManualBean)).toThrow()
    // 其余类不受影响
    expect(ctx.get(PlainRepo)).toBeInstanceOf(PlainRepo)
  })

  it('实现生命周期钩子的类自动按生命周期组件装配', async () => {
    const ctx = new AppContext().autoRegister()
    // 未显式 addLifeCycleService，但钩子被识别 → start 时执行 onAppStart
    expect(ctx.getState()).toBe('idle')
    await ctx.start()
    expect(ctx.getState()).toBe('started')
    const bean = ctx.get(LifeCycleBean)
    expect(bean.events).toEqual(['start'])

    await ctx.stop()
    expect(bean.events).toEqual(['start', 'stop'])
  })

  it('生命周期钩子类的依赖同样自动装配（拓扑启动依赖注入正常）', async () => {
    const ctx = new AppContext().autoRegister()
    await ctx.start()
    // LifeCycleWithDep 依赖 LifeCycleBean：若后者未装配，构造会失败
    const withDep = ctx.get(LifeCycleWithDep)
    expect(withDep.dep).toBeInstanceOf(LifeCycleBean)
    await ctx.stop()
  })

  it('autoRegister 与显式 addService 不冲突（已注册的跳过，不重复绑定）', () => {
    const ctx = new AppContext().addService(PlainRepo).autoRegister()
    expect(ctx.get(PlainRepo)).toBeInstanceOf(PlainRepo)
    // 重复调用幂等
    ctx.autoRegister()
    expect(ctx.get(PlainService)).toBeInstanceOf(PlainService)
  })
})
