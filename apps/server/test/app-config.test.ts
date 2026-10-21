import { describe, expect, it } from 'vitest'
import { mapServerEnv, serverAppConfigSchema } from '../src/app-config.js'

/** 只取 server 分片做校验（其余命名空间 kits schema 自己已有单测） */
const parseServer = (raw: Record<string, unknown>) => {
  const full = serverAppConfigSchema.parse(mapServerEnv({} as NodeJS.ProcessEnv))
  return serverAppConfigSchema.parse({ ...full, server: { ...full.server, ...raw } })
    .server
}

describe('server 分片：HTTP 长连接超时', () => {
  it('默认 keepAliveTimeoutMs=75s / headersTimeoutMs=80s（比 Kong 上游空闲 60s 长）', () => {
    const server = parseServer({})
    expect(server.keepAliveTimeoutMs).toBe(75_000)
    expect(server.headersTimeoutMs).toBe(80_000)
    // 关键不变量：后端空闲超时必须大于 Kong 默认的 upstream_keepalive_idle_timeout(60s)
    expect(server.keepAliveTimeoutMs).toBeGreaterThan(60_000)
  })

  it('headersTimeoutMs 必须大于 keepAliveTimeoutMs（Node 自己不会校验，实测静默接受）', () => {
    expect(() =>
      parseServer({ keepAliveTimeoutMs: 80_000, headersTimeoutMs: 75_000 }),
    ).toThrow(/必须大于/)

    expect(() =>
      // 相等也不行：定时器不同步时仍有竞态
      parseServer({ keepAliveTimeoutMs: 75_000, headersTimeoutMs: 75_000 }),
    ).toThrow(/必须大于/)

    expect(() =>
      parseServer({ keepAliveTimeoutMs: 75_000, headersTimeoutMs: 80_000 }),
    ).not.toThrow()
  })

  it('可由环境变量覆盖（KEEP_ALIVE_TIMEOUT_MS / HEADERS_TIMEOUT_MS）', () => {
    const mapped = mapServerEnv({
      KEEP_ALIVE_TIMEOUT_MS: '90000',
      HEADERS_TIMEOUT_MS: '95000',
    } as NodeJS.ProcessEnv)
    const config = serverAppConfigSchema.parse(mapped)
    expect(config.server.keepAliveTimeoutMs).toBe(90_000)
    expect(config.server.headersTimeoutMs).toBe(95_000)
  })
})

describe('agent 分片：命令执行默认关闭', () => {
  it('默认 commandEnabled=false；要本机执行必须显式 AGENT_COMMAND_ENABLED=true', () => {
    const defaults = serverAppConfigSchema.parse(mapServerEnv({} as NodeJS.ProcessEnv))
    expect(defaults.agent.commandEnabled).toBe(false)
    const mapped = mapServerEnv({ AGENT_COMMAND_ENABLED: 'true' } as NodeJS.ProcessEnv)
    expect(serverAppConfigSchema.parse(mapped).agent.commandEnabled).toBe(true)
  })
})

describe('server 分片：优雅关闭', () => {
  it('默认 shutdownTimeoutMs=25s，且留有余量给 k8s 的 grace + preStop（60s + 8s）', () => {
    const server = parseServer({})
    expect(server.shutdownTimeoutMs).toBe(25_000)
    // 不变量：排空期限必须明显小于 terminationGracePeriodSeconds - preStop，
    // 否则要么排空没走完就被 SIGKILL，要么期限形同虚设
    expect(server.shutdownTimeoutMs).toBeLessThan(60_000 - 8_000)
  })

  it('可由环境变量覆盖（SHUTDOWN_TIMEOUT_MS）', () => {
    const mapped = mapServerEnv({
      SHUTDOWN_TIMEOUT_MS: '40000',
    } as NodeJS.ProcessEnv)
    expect(serverAppConfigSchema.parse(mapped).server.shutdownTimeoutMs).toBe(40_000)
  })
})

