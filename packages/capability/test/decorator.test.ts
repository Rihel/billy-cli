import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  CapabilityDecl,
  CapabilityGroup,
  findCapabilityDecl,
  readCapabilityDecl,
  scanCapabilities,
} from '../src/decorator.js'

@CapabilityGroup({ risk: 'write', scope: 'agent' })
class BashLike {
  @CapabilityDecl({
    tool: 'bash',
    title: '执行命令',
    description: '跑一条命令',
    input: z.object({ command: z.string().describe('命令') }),
  })
  async bash(): Promise<void> {}

  @CapabilityDecl({
    tool: 'peek',
    title: '只读',
    description: '读一眼',
    risk: 'read',
    input: z.object({}),
  })
  async peek(): Promise<void> {}
}

/** 声明了 ghost，但把执行体从原型上删掉（模拟「声明与实现漂移」） */
class Broken {
  @CapabilityDecl({
    tool: 'ghost',
    title: '没有执行体',
    description: '声明了但方法不存在',
    input: z.object({}),
  })
  async ghost(): Promise<void> {}
}

describe('能力装饰器', () => {
  it('扫描出全部声明，并按组级默认值补齐', () => {
    const scanned = scanCapabilities(new BashLike())
    expect(scanned.map((item) => item.method)).toEqual(['bash', 'peek'])
    expect(scanned[0]!.decl).toMatchObject({
      tool: 'bash',
      risk: 'write',
      scope: 'agent',
      timeoutMs: 30_000,
      pagination: 'none',
    })
    // 方法级覆盖组级默认值
    expect(scanned[1]!.decl).toMatchObject({ tool: 'peek', risk: 'read', scope: 'agent' })
  })

  it('按方法名 / 工具名读同一份声明（执行体校准入参用）', () => {
    const instance = new BashLike()
    expect(readCapabilityDecl(instance, 'bash').tool).toBe('bash')
    expect(findCapabilityDecl(instance, 'peek').risk).toBe('read')
    expect(() => readCapabilityDecl(instance, 'missing')).toThrow('没有能力声明')
    expect(() => findCapabilityDecl(instance, 'missing')).toThrow('没有能力声明')
  })

  it('声明缺执行体在启动期就抛（不是运行时静默失效）', () => {
    delete (Broken.prototype as unknown as { ghost?: unknown }).ghost
    expect(() => scanCapabilities(new Broken())).toThrow('声明的执行体 ghost 不存在')
  })

  it('工具名在组内重复就抛', () => {
    @CapabilityGroup()
    class Duplicated {
      @CapabilityDecl({ tool: 'same', title: 'a', description: 'a', input: z.object({}) })
      async first(): Promise<void> {}

      @CapabilityDecl({ tool: 'same', title: 'b', description: 'b', input: z.object({}) })
      async second(): Promise<void> {}
    }
    expect(() => scanCapabilities(new Duplicated())).toThrow('工具名重复')
  })

  it('没有声明的类扫出空数组（不是能力组）', () => {
    class Plain {
      async run(): Promise<void> {}
    }
    expect(scanCapabilities(new Plain())).toEqual([])
  })
})
