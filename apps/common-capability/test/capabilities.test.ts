import { describe, expect, it } from 'vitest'
import { toRegistration } from '@repo/capability'
import { SERVICE_DEFINITIONS } from '../src/capabilities/manifest.js'

describe('能力声明（17 个 worker 能力）', () => {
  it('四个服务身份共 17 个能力，key 就是工具名', () => {
    const registrations = SERVICE_DEFINITIONS.map((service) =>
      toRegistration(service, {
        instance: { instanceId: 'cc-1', endpoint: 'http://127.0.0.1:9994' },
      }),
    )
    const keys = registrations.flatMap((registration) =>
      registration.capabilities.map((capability) => capability.tool),
    )

    expect(SERVICE_DEFINITIONS.map((service) => service.service)).toEqual([
      'exec',
      'web',
      'files',
      'memory',
    ])
    expect(keys).toHaveLength(17)
    expect(keys).toEqual(
      expect.arrayContaining(['bash', 'web-fetch', 'file-list', 'read-tool-result', 'memory-save']),
    )
    expect(new Set(keys).size).toBe(17)
  })

  it('工具名在服务内唯一', () => {
    for (const service of SERVICE_DEFINITIONS) {
      const tools = service.capabilities.map((capability) => capability.tool)
      expect(new Set(tools).size).toBe(tools.length)
    }
  })
})
