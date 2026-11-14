import { Injectable } from '@nestjs/common'
import { Redis } from 'ioredis'
import { DataSource, type DataSourceOptions } from 'typeorm'
import { specOfDriver } from './connector.specs.js'
import type {
  ConnectorProbePort,
  ConnectorProbeResult,
  ConnectorRuntime,
} from './connector.types.js'

/**
 * 连接探活（`/ai-connector/test`）——**只测"这份连接配置能不能连上"**。
 *
 * 三条边界（改代码前先读）：
 *
 * 1. **不做工具注册**：这里不 import 工具注册机、不写 `ai_tools`、不碰 `ai_tools` 的
 *    动态注册；测试成功也不意味着工具已出现（那要等同步）。
 * 2. **不跑 agent loop**：本文件只有连接与一次最小只读操作（SQL `SELECT 1` / Redis `PING`），
 *    没有驱动实例的常驻连接池 —— 用完即销毁，main 进程不留外部连接。
 * 3. **lark-cli 只做配置校验**：命令行 + 用户授权状态在 agent-runtime 的驱动里，
 *    main 不 spawn 子进程；这里校验配置与必填密钥，结论里明确说明这条边界。
 *
 * 失败不抛错：把原文（脱敏后的）交给 service 写进 `last_error`，避免一个连不上的
 * 外部库把 HTTP 变成 500。
 */

/** 单步超时上限（连接 / 查询 / PING）；外部服务不可达时不拖住请求 */
const PROBE_TIMEOUT_MS = 5_000

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** 给 promise 套一个硬超时：某些客户端在黑洞地址上的 connect 会远超自己的超时参数 */
const withTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}超时（>${PROBE_TIMEOUT_MS}ms）`)),
          PROBE_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** SQL：连一次 + `SELECT 1 AS ok`（走 TypeORM，沿用驱动同款连接参数） */
const probeSql = async (runtime: ConnectorRuntime): Promise<ConnectorProbeResult> => {
  const spec = specOfDriver('sql')
  if (!spec) return { ok: false, message: '缺少 sql 驱动的配置契约' }

  const config = spec.config.parse(runtime.config)
  const dialect = config.dialect === 'mysql' ? 'mysql' : 'postgres'
  const password = runtime.secrets.password ?? ''
  let dataSource: DataSource | null = null

  try {
    dataSource = new DataSource({
      type: dialect,
      host: String(config.host ?? ''),
      port: Number(config.port ?? 0),
      username: String(config.user ?? ''),
      database: String(config.database ?? ''),
      ...(password ? { password } : {}),
      entities: [],
      synchronize: false,
      logging: false,
      // pg 认 connectionTimeoutMillis / statement_timeout，mysql2 认 connectTimeout；
      // 两边的键都塞进 extra 没有副作用（各自忽略不认识的键）
      extra: {
        connectionTimeoutMillis: PROBE_TIMEOUT_MS,
        connectTimeout: PROBE_TIMEOUT_MS,
        ...(dialect === 'postgres'
          ? {
              statement_timeout: Number(config.statementTimeoutMs ?? PROBE_TIMEOUT_MS),
              query_timeout: PROBE_TIMEOUT_MS,
            }
          : {}),
      },
    } as DataSourceOptions)

    await withTimeout(dataSource.initialize(), '连接')
    await withTimeout(dataSource.query('SELECT 1 AS ok'), '查询')
    return { ok: true }
  } catch (error) {
    return { ok: false, message: messageOf(error) }
  } finally {
    if (dataSource?.isInitialized) {
      try {
        await dataSource.destroy()
      } catch {
        // 已经连不上时销毁也可能报错：探活结论已经拿到，这里不再覆盖
      }
    }
  }
}

/** Redis：连一次 + `PING`（用完即断，不建常驻连接池） */
const probeRedis = async (runtime: ConnectorRuntime): Promise<ConnectorProbeResult> => {
  const spec = specOfDriver('redis')
  if (!spec) return { ok: false, message: '缺少 redis 驱动的配置契约' }

  const config = spec.config.parse(runtime.config)
  const password = runtime.secrets.password ?? ''
  const client = new Redis({
    host: String(config.host ?? '127.0.0.1'),
    port: Number(config.port ?? 6379),
    db: Number(config.db ?? 0),
    ...(password ? { password } : {}),
    connectTimeout: PROBE_TIMEOUT_MS,
    commandTimeout: Number(config.commandTimeoutMs ?? PROBE_TIMEOUT_MS),
    // 探活只尝试一次：失败要把结论尽快交回页面，而不是在 ioredis 的退避里重连
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    lazyConnect: true,
    enableOfflineQueue: false,
  })

  // ioredis 的连接失败走 error 事件；不挂监听会打一条"Unhandled error event"噪音，
  // 而且 connect() 的 reject 往往只有一句 "Connection is closed."，丢掉真正原因（ECONNREFUSED）。
  // 这里把原始错误记下来，排障时用得上；错误本身仍以返回结论交给上层。
  let lastError: unknown = null
  client.on('error', (error: unknown) => {
    lastError = error
  })

  try {
    await withTimeout(client.connect(), '连接')
    const pong = await withTimeout(client.ping(), 'PING')
    return pong === 'PONG' ? { ok: true } : { ok: false, message: `PING 返回 ${String(pong)}` }
  } catch (error) {
    return { ok: false, message: messageOf(lastError ?? error) }
  } finally {
    try {
      client.disconnect()
    } catch {
      // 已断开时 disconnect 是幂等的，忽略
    }
  }
}

/** lark-cli：只校验配置与必填密钥（命令行与用户授权在 runtime） */
const probeLarkCli = async (runtime: ConnectorRuntime): Promise<ConnectorProbeResult> => {
  const spec = specOfDriver('lark-cli')
  if (!spec) return { ok: false, message: '缺少 lark-cli 驱动的配置契约' }

  spec.config.parse(runtime.config)
  const missing = spec.secrets
    .filter((field) => field.secret && field.required)
    .filter((field) => !runtime.secrets[field.key]?.trim())
    .map((field) => field.label)
  if (missing.length > 0) {
    return { ok: false, message: `缺少必填密钥：${missing.join('、')}` }
  }

  return {
    ok: true,
    message:
      '配置校验通过；lark-cli 的实际连通性由 agent-runtime 在同步 / 调用时验证（main 不执行命令行）',
  }
}

@Injectable()
export class ConnectorProbeService implements ConnectorProbePort {
  /** 按驱动分派；未知驱动 = 配置里写了不存在的接法，直接回失败结论 */
  async probe(driver: string, runtime: ConnectorRuntime): Promise<ConnectorProbeResult> {
    switch (driver) {
      case 'sql':
        return probeSql(runtime)
      case 'redis':
        return probeRedis(runtime)
      case 'lark-cli':
        return probeLarkCli(runtime)
      default:
        return { ok: false, message: `未知的驱动: ${driver}` }
    }
  }
}
