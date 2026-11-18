import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { toRegistration, type ServiceDefinition } from '../src/define.js'
import { CapabilityRegistrar, type CapabilityRegistrarClient } from '../src/registrar.js'

const service: ServiceDefinition = {
  service: 'exec',
  title: '通用能力',
  owner: '平台组',
  capabilities: [
    {
      tool: 'bash',
      title: '执行命令',
      description: '跑一条命令',
      input: z.object({ command: z.string() }),
    },
  ],
}

const registration = (manual = false) =>
  toRegistration(
    service,
    manual
      ? { source: 'manual', baseUrl: 'https://exec.example.com' }
      : { instance: { instanceId: 'cc-1', endpoint: 'http://127.0.0.1:9994' } },
  )

/** 桩客户端：生命周期编排只依赖这三个方法（HTTP 行为钉在 internal-sdk） */
const stubClient = () => {
  const calls = {
    register: 0,
    heartbeat: [] as Array<{ service: string; instanceId: string; active: number }>,
    deregisterInstance: [] as Array<{ service: string; instanceId: string }>,
  }
  let known = true
  const client: CapabilityRegistrarClient = {
    register: async () => {
      calls.register += 1
      return {
        accepted: true,
        service: 'exec',
        version: 1,
        added: [],
        changed: [],
        removed: [],
        capabilities: [{ tool: 'bash', key: 'bash', name: 'bash' }],
      }
    },
    heartbeat: async (name, instanceId, active) => {
      calls.heartbeat.push({ service: name, instanceId, active })
      return { known }
    },
    deregisterInstance: async (name, instanceId) => {
      calls.deregisterInstance.push({ service: name, instanceId })
      return { removed: true }
    },
  }
  return { client, calls, setKnown: (value: boolean) => (known = value) }
}

describe('CapabilityRegistrar（生命周期编排）', () => {
  it('start 上报一次 → tick 带 active 心跳 → stop 注销实例', async () => {
    const { client, calls } = stubClient()
    const registrar = new CapabilityRegistrar({
      client,
      registration: registration(),
      activeProvider: () => 3,
    })

    await registrar.start()
    await registrar.tick()
    await registrar.stop()

    expect(calls.register).toBe(1)
    expect(calls.heartbeat).toEqual([{ service: 'exec', instanceId: 'cc-1', active: 3 }])
    expect(calls.deregisterInstance).toEqual([{ service: 'exec', instanceId: 'cc-1' }])
  })

  it('心跳返回 known=false 时自动重发 register（网关重启后自愈）', async () => {
    const { client, calls, setKnown } = stubClient()
    const registrar = new CapabilityRegistrar({ client, registration: registration() })
    await registrar.start()

    setKnown(false)
    await registrar.tick()

    expect(calls.register).toBe(2)
    await registrar.stop()
  })

  it('外部服务（没有实例）不发心跳、不注销实例', async () => {
    const { client, calls } = stubClient()
    const registrar = new CapabilityRegistrar({ client, registration: registration(true) })
    await registrar.start()

    await registrar.tick()
    await registrar.stop()

    expect(calls.register).toBe(1)
    expect(calls.heartbeat).toEqual([])
    expect(calls.deregisterInstance).toEqual([])
  })

  it('登记失败不抛出（不阻塞启动），记录 warn', async () => {
    const warns: string[] = []
    const client: CapabilityRegistrarClient = {
      register: async () => {
        throw new Error('网关不可用')
      },
      heartbeat: async () => ({ known: false }),
      deregisterInstance: async () => ({ removed: false }),
    }
    const registrar = new CapabilityRegistrar({
      client,
      registration: registration(),
      logger: { info: () => {}, warn: (message) => warns.push(message) },
    })

    await expect(registrar.start()).resolves.toBeUndefined()
    expect(warns).toContain('capability.register_failed')
    await registrar.stop()
  })
})
