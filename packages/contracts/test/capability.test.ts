import { describe, expect, it } from 'vitest'
import {
  ServiceRegistrationSchema,
  isCapabilityKey,
  isServiceName,
  isToolName,
} from '../src/capability.js'

describe('能力 key：扁平工具名（xxx-xxx）', () => {
  it('工具名就是能力 key，服务不拼进 key', () => {
    expect(isCapabilityKey('file-list')).toBe(true)
    expect(isCapabilityKey('memory-save')).toBe(true)
    expect(isCapabilityKey('exec/bash')).toBe(false)
    expect(isCapabilityKey('Bad-Key')).toBe(false)
  })

  it('工具名禁止 `__` 与非法字符（模型面名字与 key 一致）', () => {
    expect(isToolName('send')).toBe(true)
    expect(isToolName('send__v2')).toBe(false)
    expect(isServiceName('common-capability')).toBe(true)
    expect(isServiceName('Common')).toBe(false)
  })
})

describe('服务登记契约', () => {
  const base = {
    service: 'order',
    title: '订单服务',
    owner: 'B 团队',
    capabilities: [{ tool: 'create', title: '下单', description: '创建订单' }],
  }

  it('内部服务必须带 instance；外部服务必须带 baseUrl', () => {
    expect(ServiceRegistrationSchema.safeParse({ ...base, source: 'code' }).success).toBe(false)
    expect(ServiceRegistrationSchema.safeParse({ ...base, source: 'manual' }).success).toBe(false)
    expect(
      ServiceRegistrationSchema.safeParse({
        ...base,
        source: 'code',
        instance: { instanceId: 'cc-1', endpoint: 'http://10.0.0.1:9994' },
      }).success,
    ).toBe(true)
    expect(
      ServiceRegistrationSchema.safeParse({
        ...base,
        source: 'manual',
        baseUrl: 'https://o.example',
      }).success,
    ).toBe(true)
  })

  it('工具名在服务内唯一', () => {
    const result = ServiceRegistrationSchema.safeParse({
      ...base,
      source: 'manual',
      baseUrl: 'https://o.example',
      capabilities: [
        { tool: 'create', title: '下单', description: '创建订单' },
        { tool: 'create', title: '下单2', description: '重复' },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('执行声明缺省是 sync', () => {
    const parsed = ServiceRegistrationSchema.parse({
      ...base,
      source: 'manual',
      baseUrl: 'https://o.example',
    })
    expect(parsed.capabilities[0]!.execution.mode).toBe('sync')
    expect(parsed.capabilities[0]!.execution.owner).toBe('session')
  })
})
