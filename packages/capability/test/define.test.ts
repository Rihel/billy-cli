import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { toInputSchema, toRegistration, type ServiceDefinition } from '../src/define.js'

const BashInput = z.object({
  command: z.string().min(1).max(2_000).describe('要执行的整条命令行'),
  cwd: z.string().optional().describe('工作目录；不允许跑到工作目录之外'),
})

const execService: ServiceDefinition = {
  service: 'exec',
  title: '通用能力',
  owner: '平台组',
  capabilities: [
    {
      tool: 'bash',
      title: '执行 bash 命令',
      description: '在沙箱里跑一条命令',
      input: BashInput,
      risk: 'write',
      execution: {
        mode: 'task',
        owner: 'session',
        yieldMs: 45_000,
        wait: { maxWaitMs: 60_000 },
        cancel: 'supported',
      },
    },
  ],
}

describe('toInputSchema / toRegistration', () => {
  it('zod → JSON Schema：.describe() 变成字段说明', () => {
    const schema = toInputSchema(BashInput)
    expect(schema).toMatchObject({
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的整条命令行' },
        cwd: { type: 'string', description: '工作目录；不允许跑到工作目录之外' },
      },
      required: ['command'],
    })
  })

  it('登记体里不带 key（key 就是工具名），执行声明按声明透传', () => {
    const registration = toRegistration(execService, {
      instance: {
        instanceId: 'cc-1',
        endpoint: 'http://127.0.0.1:9994',
        maxConcurrency: 8,
      },
    })

    expect(registration.service).toBe('exec')
    expect(registration.source).toBe('code')
    expect(registration.protocol).toBe('capability')
    expect(registration.instance?.instanceId).toBe('cc-1')
    expect(registration.capabilities[0]).not.toHaveProperty('key')
    expect(registration.capabilities[0]).toMatchObject({
      tool: 'bash',
      risk: 'write',
      execution: { mode: 'task', owner: 'session', cancel: 'supported' },
    })
    expect(registration.capabilities[0]!.inputSchema).toMatchObject({ type: 'object' })
  })

  it('register:false 的能力被声明但不进登记体（编排原语）', () => {
    const mixed: ServiceDefinition = {
      service: 'agent',
      title: '编排',
      owner: '平台组',
      capabilities: [
        {
          tool: 'list',
          title: '列子助手',
          description: '列出子助手',
          input: z.object({}),
          register: false,
        },
        {
          tool: 'run',
          title: '起子助手',
          description: '起一个子助手',
          input: z.object({ task: z.string().describe('任务') }),
        },
      ],
    }

    const registration = toRegistration(mixed, {
      instance: { instanceId: 'x', endpoint: 'http://127.0.0.1:1' },
    })
    expect(registration.capabilities.map((item) => item.tool)).toEqual(['run'])
  })

  it('外部服务用 baseUrl 登记，没有实例概念；protocol 可选透传', () => {
    const registration = toRegistration(execService, {
      source: 'manual',
      baseUrl: 'https://orders.example.com',
      protocol: 'mcp',
    })
    expect(registration.source).toBe('manual')
    expect(registration.protocol).toBe('mcp')
    expect(registration.baseUrl).toBe('https://orders.example.com')
    expect(registration.instance).toBeUndefined()
  })

  it('内部服务不接受 mcp 协议（由契约拒收）', () => {
    expect(() =>
      toRegistration(execService, {
        instance: { instanceId: 'cc-1', endpoint: 'http://127.0.0.1:9994' },
        protocol: 'mcp',
      }),
    ).toThrow('内部服务只支持能力协议')
  })
})
