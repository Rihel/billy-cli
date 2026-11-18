import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineCapability, defineService, toRegistration } from '../src/define.js'
import { CapabilityRegistrar, CapabilityRegistryClient } from '../src/registry-client.js'

interface Captured {
  path: string
  body: Record<string, unknown>
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}`
}

const registration = toRegistration(
  defineService({
    service: 'exec',
    title: '通用能力',
    owner: '平台组',
    capabilities: [
      defineCapability({
        tool: 'bash',
        title: '执行命令',
        description: '跑一条命令',
        input: z.object({ command: z.string() }),
      }),
    ],
  }),
  { instance: { instanceId: 'cc-1', endpoint: 'http://127.0.0.1:9994' } },
)

describe('CapabilityRegistryClient / CapabilityRegistrar', () => {
  it('注册 / 心跳 / 注销都走 POST + body，返回信封里的 data', async () => {
    const captured: Captured[] = []
    let known = true
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
      })
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as Record<string, unknown>
        captured.push({ path: req.url ?? '', body })
        const data =
          req.url === '/v1/services/register'
            ? {
                accepted: true,
                service: 'exec',
                version: 1,
                added: ['exec/bash'],
                changed: [],
                removed: [],
                capabilities: [{ tool: 'bash', key: 'exec/bash', name: 'exec__bash' }],
              }
            : req.url === '/v1/instances/heartbeat'
              ? { known }
              : { removed: true }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 0, data }))
      })
    })
    servers.push(server)
    const baseUrl = await listen(server)
    const client = new CapabilityRegistryClient({ baseUrl, token: 'token' })

    const registered = await client.register(registration)
    expect(registered.capabilities[0]?.name).toBe('exec__bash')
    expect(captured[0]).toMatchObject({
      path: '/v1/services/register',
      body: { service: 'exec', source: 'code', instance: { instanceId: 'cc-1' } },
    })

    expect(await client.heartbeat('exec', 'cc-1', 3)).toEqual({ known: true })
    expect(captured[1]).toMatchObject({
      path: '/v1/instances/heartbeat',
      body: { service: 'exec', instanceId: 'cc-1', active: 3 },
    })

    expect(await client.deregisterInstance('exec', 'cc-1')).toEqual({ removed: true })
    expect(captured[2]).toMatchObject({ path: '/v1/instances/deregister' })
  })

  it('心跳返回 known=false 时自动重发 register', async () => {
    const paths: string[] = []
    let known = false
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        paths.push(req.url ?? '')
        const data =
          req.url === '/v1/services/register'
            ? {
                accepted: true,
                service: 'exec',
                version: 1,
                added: [],
                changed: [],
                removed: [],
                capabilities: [],
              }
            : { known }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 0, data }))
      })
    })
    servers.push(server)
    const baseUrl = await listen(server)

    const registrar = new CapabilityRegistrar({
      client: new CapabilityRegistryClient({ baseUrl, token: 't' }),
      registration,
      heartbeatIntervalMs: 60_000,
    })
    try {
      await registrar.tick()
      expect(paths).toEqual(['/v1/instances/heartbeat', '/v1/services/register'])

      known = true
      await registrar.tick()
      expect(paths.at(-1)).toBe('/v1/instances/heartbeat')
    } finally {
      await registrar.stop()
    }
  })
})
