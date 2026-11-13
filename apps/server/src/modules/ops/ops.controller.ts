import { Controller, Get, HttpCode, Inject } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Db, RedisStore, WorkspaceRuntimeService } from '@repo/kits'
import { AppErrorCodes } from '@repo/shared'
import { hostname } from 'node:os'
import { BoundaryError } from '../../common/index.js'
import { resolveServerConfig, type ServerConfig } from '../../config.js'

/**
 * 单次依赖探活超时（ms）：与 k8s 探针的 `timeoutSeconds` 对齐。
 * 依赖假死（TCP 连上但不返回）时必须自己先给出结论，不能把请求挂到探针超时。
 */
const READINESS_CHECK_TIMEOUT_MS = 2_000

/** 给依赖探活加超时；超时按「不可用」处理（`Promise.race` 已消费原 promise 的 reject，不会产生未处理拒绝） */
const withTimeout = async (probe: Promise<unknown>, ms: number): Promise<void> => {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      probe,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('探活超时')), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 运维探针控制器（**根路径**，免鉴权）。
 *
 * 为什么单独有它：业务路由统一 POST，而 k8s 的 `httpGet` 探针**只会发 GET**，
 * 所以探针接口必须是本工程唯一的 GET 例外。三个接口的语义刻意分开：
 *
 * - `GET /healthz`（liveness）：**只证明进程活着，不探外部依赖**。若 liveness 依赖 DB / Redis，
 *   一次依赖抖动会让 k8s 把所有 pod 一起重启（重启也解决不了依赖故障），直接演变成雪崩。
 * - `GET /readyz`（readiness）：探 DB / Redis，任一不可用即 **HTTP 503** 主动摘流
 *   （k8s 只把 2xx / 3xx 当就绪）。**不使用 200 + degraded**：那样探针永远就绪，
 *   滚动更新时新 pod 会在依赖未就绪时就开始接流量。
 * - `GET /info`：部署与运行时信息，用于核对「线上跑的到底是哪个构建」、核对长连接超时实际生效值。
 *
 * 三个接口都由 `RequestMetricsMiddleware` / `RequestLoggerMiddleware` 按
 * `OPS_PROBE_PATHS` 跳过探针（`/healthz`、`/readyz`），避免刷屏并污染 QPS / 错误率；
 * `/info` 是按需调用，照常记日志。
 */
@Controller()
export class OpsController {
  /** 应用级业务配置（bootstrap 前已加载校验，构造期解析一次即可） */
  private readonly server: ServerConfig

  /** 进程启动时间：由 uptime 反推（控制器在 `listen` 前构造，误差可忽略） */
  private readonly startedAt = new Date(Date.now() - process.uptime() * 1000)

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(RedisStore) private readonly redis: RedisStore,
    @Inject(ConfigService) config: ConfigService,
    @Inject(WorkspaceRuntimeService) private readonly workspace: WorkspaceRuntimeService,
  ) {
    this.server = resolveServerConfig(config)
  }

  /**
   * 存活探针（livenessProbe）：进程能响应即 200，**不探任何外部依赖**。
   * 返回 `uptimeSeconds` / `startedAt`，便于人工确认「是不是刚被重启过」。
   */
  @Get('healthz')
  @HttpCode(200)
  healthz() {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: this.startedAt.toISOString(),
    }
  }

  /**
   * 就绪探针（readinessProbe）：探 DB 与 Redis，任一不可用 → HTTP 503 + `code: 5002`。
   *
   * 用 `BoundaryError` 而不是 `AppError`：`AppExceptionFilter` 对边界错误不打错误日志、
   * 不触发技术告警 —— 探针每 3s 一次，若走告警链路会变成告警风暴（依赖故障本身另有告警）。
   * 失败的依赖名写进 `message`（如「服务未就绪：数据库不可用」），便于 `curl` 直接定位。
   */
  @Get('readyz')
  @HttpCode(200)
  async readyz() {
    const checks: Record<'db' | 'redis', 'ok' | 'failed'> = {
      db: 'ok',
      redis: 'ok',
    }
    const failed: string[] = []

    try {
      await withTimeout(this.db.dataSource.query('SELECT 1'), READINESS_CHECK_TIMEOUT_MS)
    } catch {
      checks.db = 'failed'
      failed.push('数据库')
    }

    try {
      await withTimeout(this.redis.raw.ping(), READINESS_CHECK_TIMEOUT_MS)
    } catch {
      checks.redis = 'failed'
      failed.push('Redis')
    }

    if (failed.length > 0) {
      throw new BoundaryError(
        AppErrorCodes.NotReady,
        `服务未就绪：依赖不可用（${failed.join('、')}）`,
        503,
      )
    }

    return {
      status: 'ok',
      checks,
      uptimeSeconds: Math.round(process.uptime()),
    }
  }

  /**
   * 运行信息：版本（`APP_VERSION`，默认 `dev`）+ 运行时 + 已生效的长连接超时（排查 502 竞态用）
   * + **工作区执行环境的实际选型**（沙箱可用性 / 部署允许集合 / 实际会用什么）。
   */
  @Get('info')
  @HttpCode(200)
  async info() {
    const workspace = await this.workspace.status()
    return {
      name: 'billy-server',
      version: this.server.appVersion,
      nodeVersion: process.version,
      hostname: hostname(),
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: this.startedAt.toISOString(),
      http: {
        keepAliveTimeoutMs: this.server.keepAliveTimeoutMs,
        headersTimeoutMs: this.server.headersTimeoutMs,
      },
      workspace: {
        mode: workspace.mode,
        fileAccessOptions: workspace.fileAccessOptions,
        sandbox: {
          available: workspace.sandbox.available,
          impl: workspace.sandbox.impl ?? null,
          code: workspace.sandbox.reason?.code ?? null,
          message: workspace.sandbox.reason?.message ?? null,
        },
      },
    }
  }
}
