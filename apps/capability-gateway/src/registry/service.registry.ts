import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common'
import { AppLogger, Db, RedisStore } from '@repo/kits'
import { AiCapabilityServiceEntity, AiServiceGrantEntity } from '@repo/db'
import { randomUUID } from 'node:crypto'
import {
  RegisteredServiceSchema,
  ServiceRegistrationSchema,
  type CapabilityDecl,
  type CapabilityInfo,
  type InstanceHeartbeat,
  type RegisteredInstance,
  type RegisteredService,
  type ServiceRegistrationInput,
  type ServiceRegisterResult,
} from '@repo/contracts'
import { ToolGatewayConfig, type ToolGatewayConfigValue } from '../config/app-config.js'
import {
  BUILTIN_CAPABILITIES,
  BUILTIN_CAPABILITY_KEYS,
  GATEWAY_SERVICE,
  findBuiltinCapability,
} from './builtin.capabilities.js'
import { UnsafeTargetError, allowPrivateNetworkOf, assertSafeTarget } from './target.guard.js'

/** 注册表快照：服务不多，一个 key 存整份，省掉索引维护 */
interface TaskLocation {
  service: string
  endpoint: string
  instanceId: string
  capability: string
}

const STORE_KEY = 'ai:capability:registry'
const CREDENTIALS_KEY = 'ai:capability:credentials'

/** 稳定序列化：只用于判断「这份声明和上一份是否一样」 */
const stable = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
}

const scopeAllows = (
  caller: { isAdmin?: boolean; agentKey: string },
  capability: CapabilityDecl,
): boolean => {
  const effective = capability.scope
  if (effective === 'admin') return caller.isAdmin === true
  if (effective === 'user') return caller.isAdmin !== true
  if (effective === 'agent') return (capability.allowedAgents ?? []).includes(caller.agentKey)
  return true
}

/**
 * 能力注册表（网关侧）。
 *
 * - **服务是能力的归属**，实例只提供地址与负载；
 * - 内部服务（`source=code`）按 `active / maxConcurrency` 选最闲的实例；
 * - 外部服务（`source=manual`）只有一个 `baseUrl`，不做负载均衡；
 * - 注册是**一次性声明**：清单从服务来，心跳只刷 `active`。
 *
 * 存储是「内存 + Redis 快照」：Redis 只做多副本共享与重启恢复，读路径不走 Redis。
 */
@Injectable()
export class ServiceRegistry {
  private readonly services = new Map<string, RegisteredService>()
  /** 出站凭据单独存：目录/快照里只留 `hasCredential` */
  private readonly credentials = new Map<string, string>()
  /** runId → 本轮发起的 session 任务（停止对话时级联取消；内存 + Redis） */
  private readonly runTasks = new Map<string, { ids: string[]; expiresAt: number }>()
  /** taskId → 发起它的实例（内存 + Redis，Redis 里带 TTL） */
  private readonly tasks = new Map<
    string,
    {
      location: TaskLocation
      expiresAt: number
    }
  >()
  private loading: Promise<void> | null = null
  /** 管理员授权缓存（5s）：授权变更最多 5s 生效 */
  private readonly grantCache = new Map<string, { at: number; services: Set<string> }>()

  constructor(
    @Inject(ToolGatewayConfig) private readonly config: ToolGatewayConfigValue,
    @Optional() @Inject(RedisStore) private readonly redis?: RedisStore,
    @Optional() @Inject(AppLogger) private readonly logger?: AppLogger,
    /** DB 是目录的事实源（Redis 只是运行时快照）；单测不传时退回纯内存 */
    @Optional() @Inject(Db) private readonly db?: Db,
  ) {}

  /** 登记 / 更新一个服务（内部服务每个实例启动时都会调一次） */
  async register(input: ServiceRegistrationInput): Promise<ServiceRegisterResult> {
    await this.ensureLoaded()
    const parsed = ServiceRegistrationSchema.parse(input)
    // 外部服务：默认 https、内网 / 回环 / 元数据地址一律拒绝（协议 §4.4）
    if (parsed.source === 'manual' && parsed.baseUrl) {
      try {
        await assertSafeTarget(parsed.baseUrl, {
          allowHttp: parsed.allowHttp,
          allowPrivateNetwork: allowPrivateNetworkOf(this.config.allowPrivateNetwork),
        })
      } catch (error) {
        if (error instanceof UnsafeTargetError) throw new BadRequestException(error.message)
        throw error
      }
    }
    const now = Date.now()
    for (const capability of parsed.capabilities) {
      if (BUILTIN_CAPABILITY_KEYS.has(capability.tool)) {
        throw new ConflictException(
          `工具名 ${capability.tool} 是网关内建能力（wait-task / cancel-task），不能登记`,
        )
      }
    }
    const existing = this.services.get(parsed.service)
    const previous = new Map((existing?.capabilities ?? []).map((item) => [item.tool, item]))

    const added: string[] = []
    const changed: string[] = []
    const removed: string[] = []
    for (const capability of parsed.capabilities) {
      const key = capability.tool
      const before = previous.get(capability.tool)
      if (!before) added.push(key)
      else if (stable(before) !== stable(capability)) changed.push(key)
    }
    for (const tool of previous.keys()) {
      if (!parsed.capabilities.some((item) => item.tool === tool)) {
        removed.push(tool)
      }
    }

    const deprecated = new Set(existing?.deprecated ?? [])
    for (const key of removed) deprecated.add(key.slice(key.indexOf('/') + 1))
    for (const capability of parsed.capabilities) deprecated.delete(capability.tool)

    for (const capability of parsed.capabilities) {
      for (const other of this.services.values()) {
        if (other.service === parsed.service) continue
        if (other.capabilities.some((item) => item.tool === capability.tool)) {
          throw new ConflictException(
            `工具名 ${capability.tool} 已被服务 ${other.service} 占用，能力 key 必须全局唯一`,
          )
        }
      }
    }

    if (parsed.auth?.credential) this.credentials.set(parsed.service, parsed.auth.credential)

    const instances: Record<string, RegisteredInstance> = { ...existing?.instances }
    if (parsed.instance) {
      const before = instances[parsed.instance.instanceId]
      instances[parsed.instance.instanceId] = {
        instanceId: parsed.instance.instanceId,
        endpoint: parsed.instance.endpoint,
        maxConcurrency: parsed.instance.maxConcurrency,
        active: before?.active ?? 0,
        lastSeenAt: now,
        draining: false,
      }
    }

    const hasChanges = added.length + changed.length + removed.length > 0
    const service: RegisteredService = {
      service: parsed.service,
      title: parsed.title,
      owner: parsed.owner,
      source: parsed.source,
      protocol: parsed.protocol,
      healthPath: parsed.healthPath,
      allowHttp: parsed.allowHttp,
      status: existing?.status === 'disabled' ? 'disabled' : parsed.status,
      capabilities: parsed.capabilities,
      deprecated: [...deprecated],
      instances,
      probe: existing?.probe ?? {
        state: 'unknown',
        failures: 0,
        successes: 0,
        lastProbedAt: 0,
      },
      version: existing ? existing.version + (hasChanges ? 1 : 0) : 1,
      updatedAt: now,
      ...(parsed.description === undefined ? {} : { description: parsed.description }),
      ...(parsed.baseUrl === undefined ? {} : { baseUrl: parsed.baseUrl }),
      ...(parsed.auth === undefined
        ? {}
        : {
            auth: {
              mode: parsed.auth.mode,
              header: parsed.auth.header,
              hasCredential:
                Boolean(parsed.auth.credential) || existing?.auth?.hasCredential === true,
            },
          }),
    }
    this.services.set(parsed.service, service)
    await this.persist()

    return {
      accepted: true,
      service: parsed.service,
      version: service.version,
      added,
      changed,
      removed,
      capabilities: parsed.capabilities.map((capability) => ({
        tool: capability.tool,
        key: capability.tool,
        name: capability.tool,
      })),
    }
  }

  /** 服务退役：整条记录删掉（能力随之从目录消失） */
  async deregisterService(service: string): Promise<{ removed: boolean }> {
    await this.ensureLoaded()
    const removed = this.services.delete(service)
    if (removed) await this.persist()
    return { removed }
  }

  /** 实例心跳：只刷 active 与 lastSeenAt；实例不认识时让客户端重发 register */
  async heartbeat(input: InstanceHeartbeat): Promise<{ known: boolean }> {
    await this.ensureLoaded()
    const service = this.services.get(input.service)
    const instance = service?.instances[input.instanceId]
    if (!service || !instance) return { known: false }
    instance.active = input.active
    instance.lastSeenAt = Date.now()
    await this.persist()
    return { known: true }
  }

  /** 实例摘除（优雅停机）：只摘流量，服务记录与能力保留 */
  async deregisterInstance(service: string, instanceId: string): Promise<{ removed: boolean }> {
    await this.ensureLoaded()
    const target = this.services.get(service)
    if (!target) return { removed: false }
    const removed = delete target.instances[instanceId]
    if (removed) await this.persist()
    return { removed }
  }

  /** 目录：只出 `active` 且未 `deprecated` 的能力；`available` 不代表能力存在与否 */
  async catalog(): Promise<CapabilityInfo[]> {
    await this.ensureLoaded()
    const items: CapabilityInfo[] = []
    for (const service of this.services.values()) {
      if (service.status !== 'active') continue
      const available =
        service.source === 'manual'
          ? service.probe.state !== 'down'
          : this.liveInstances(service).length > 0
      for (const capability of service.capabilities) {
        if (service.deprecated.includes(capability.tool)) continue
        const key = capability.tool
        items.push({
          key,
          name: key,
          service: service.service,
          tool: capability.tool,
          title: capability.title,
          description: capability.description,
          inputSchema: capability.inputSchema,
          risk: capability.risk,
          scope: capability.scope,
          available,
          tags: capability.tags,
        })
      }
    }
    // 内建能力不属于任何服务：始终在目录里（任务结果只能靠轮询拿）
    for (const capability of BUILTIN_CAPABILITIES) {
      items.push({
        key: capability.tool,
        name: capability.tool,
        service: GATEWAY_SERVICE,
        tool: capability.tool,
        title: capability.title,
        description: capability.description,
        inputSchema: capability.inputSchema,
        risk: capability.risk,
        scope: capability.scope,
        available: true,
        tags: capability.tags,
      })
    }
    return items
  }

  /**
   * 服务级授权：`manual` 服务必须被授权；`code` 服务默认全部可用。
   *
   * 单测 / 无 DB 场景不拦（生产网关必然有 DB）；未登录或非管理员一律拒绝 manual。
   */
  async canUseService(
    caller: { isAdmin?: boolean; userId?: string | null },
    service: RegisteredService,
  ): Promise<boolean> {
    if (service.source !== 'manual') return true
    if (!this.db) return true
    if (!caller.isAdmin || !caller.userId) return false
    const cached = this.grantCache.get(caller.userId)
    let services: Set<string>
    if (cached && Date.now() - cached.at < 5_000) {
      services = cached.services
    } else {
      const rows = await this.db
        .getRepository(AiServiceGrantEntity)
        .find({ where: { principalType: 'admin', principalId: caller.userId } })
      services = new Set(rows.map((row) => row.service))
      this.grantCache.set(caller.userId, { at: Date.now(), services })
    }
    return services.has(service.service)
  }

  /** 按调用方过滤（先服务级授权，再 scope 规则） */
  async listFor(caller: {
    isAdmin?: boolean
    userId?: string | null
    agentKey: string
    rootAgentKey: string
  }): Promise<CapabilityInfo[]> {
    const items = await this.catalog()
    const visible: CapabilityInfo[] = []
    for (const item of items) {
      const service = item.service === GATEWAY_SERVICE ? null : this.services.get(item.service)
      const capability =
        service === null
          ? findBuiltinCapability(item.tool)
          : service?.capabilities.find((entry) => entry.tool === item.tool)
      if (!capability) continue
      if (service && !(await this.canUseService(caller, service))) continue
      if (capability.scope === 'agent') {
        const allowed = capability.allowedAgents ?? []
        if (!allowed.includes(caller.agentKey) && !allowed.includes(caller.rootAgentKey)) continue
      } else if (!scopeAllows(caller, capability)) {
        continue
      }
      visible.push(item)
    }
    return visible
  }

  /**
   * 找到一条能力（目录里存在且未 deprecated）。
   *
   * key 是**工具名本身**；跨服务重名在登记时已经拒绝，所以这里唯一命中。
   */
  async find(
    key: string,
  ): Promise<{ service: RegisteredService; capability: CapabilityDecl; key: string } | null> {
    await this.ensureLoaded()
    for (const service of this.services.values()) {
      if (service.status !== 'active') continue
      if (service.deprecated.includes(key)) continue
      const capability = service.capabilities.find((item) => item.tool === key)
      if (capability) return { service, capability, key }
    }
    return null
  }

  /** 兼容旧调用：现在 key 就是工具名 */
  async resolveKey(key: string): Promise<string | null> {
    return (await this.find(key)) ? key : null
  }

  /**
   * 选一个可执行目标：
   * - 内部服务：失联 / draining 之外，按 `active / maxConcurrency` 最低，平手随机；
   * - 外部服务：固定 `baseUrl`。
   */
  async pick(
    key: string,
  ): Promise<{ service: RegisteredService; endpoint: string; instanceId: string } | null> {
    const found = await this.find(key)
    if (!found) return null
    const { service } = found
    const live = this.liveInstances(service)
    if (live.length > 0) {
      const ratio = (item: RegisteredInstance): number =>
        item.active / Math.max(1, item.maxConcurrency)
      let best = live[0]!
      for (const item of live) if (ratio(item) < ratio(best)) best = item
      const tied = live.filter((item) => ratio(item) === ratio(best))
      const chosen = tied[Math.floor(Math.random() * tied.length)] ?? best
      return { service, endpoint: chosen.endpoint, instanceId: chosen.instanceId }
    }
    if (service.source === 'manual') {
      // 探活已判定 down：目录保留（available:false），但不再派发——调用明确报 no-provider（设计 D9）
      if (service.probe.state === 'down') return null
      if (service.baseUrl) return { service, endpoint: service.baseUrl, instanceId: 'external' }
    }
    return null
  }

  /** 后台用：切换服务状态（draft / active / disabled） */
  async setStatus(
    service: string,
    status: 'draft' | 'active' | 'disabled',
  ): Promise<{ updated: boolean }> {
    await this.ensureLoaded()
    const target = this.services.get(service)
    if (!target) return { updated: false }
    target.status = status
    target.updatedAt = Date.now()
    await this.persist()
    return { updated: true }
  }

  /** 后台列表：不出凭据，只给 `hasCredential` 与探活状态 */
  async adminList(): Promise<
    Array<
      Omit<RegisteredService, 'auth'> & {
        auth?: { mode: string; header: string; hasCredential: boolean }
      }
    >
  > {
    await this.ensureLoaded()
    // 网关内建能力（wait-task / cancel-task / tool-search）不属于任何登记服务：
    // 单独合成一条只读服务，后台才能在「能力服务」里看到并配置工具级配置。
    const builtin = RegisteredServiceSchema.parse({
      service: GATEWAY_SERVICE,
      title: '网关内建',
      description: 'wait-task / cancel-task / tool-search；不参与服务登记与探活',
      owner: '平台组',
      source: 'code',
      protocol: 'capability',
      healthPath: '/',
      allowHttp: false,
      status: 'active',
      capabilities: BUILTIN_CAPABILITIES,
      deprecated: [],
      instances: {},
      version: 1,
      updatedAt: Date.now(),
    })
    return [...this.services.values(), builtin]
  }

  /** 外部服务的出站凭据（内部服务返回 null，用网关自己的内部令牌） */
  async credentialFor(service: string): Promise<string | null> {
    await this.ensureLoaded()
    return this.credentials.get(service) ?? null
  }

  /** 探活结果：连续 3 次失败转 down，连续 2 次成功转 up（防抖） */
  async markProbe(service: string, ok: boolean): Promise<{ state: string } | null> {
    await this.ensureLoaded()
    const target = this.services.get(service)
    if (!target) return null
    const probe = { ...target.probe, lastProbedAt: Date.now() }
    if (ok) {
      probe.failures = 0
      probe.successes += 1
      if (probe.successes >= 2) probe.state = 'up'
    } else {
      probe.successes = 0
      probe.failures += 1
      if (probe.failures >= 3) probe.state = 'down'
    }
    target.probe = probe
    await this.persist()
    return { state: probe.state }
  }

  /** 任务亲和：`wait` / `cancel` 要回到发起它的那个实例 */
  async saveTask(
    taskId: string,
    location: {
      service: string
      endpoint: string
      instanceId: string
      capability: string
    },
    ttlSeconds: number,
  ): Promise<void> {
    this.tasks.set(taskId, { location, expiresAt: Date.now() + ttlSeconds * 1_000 })
    if (!this.redis) return
    await this.redis
      .setJson(`ai:capability:task:${taskId}`, location, ttlSeconds)
      .catch((error: unknown) =>
        this.logger?.warn('capability.registry.task_persist_failed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      )
  }

  /** 记一行「这轮对话发起了哪个任务」（只记 `owner=session` 的） */
  async saveRunTask(runId: string, taskId: string, ttlSeconds: number): Promise<void> {
    const now = Date.now()
    const existing = this.runTasks.get(runId)
    const ids = existing && existing.expiresAt > now ? [...existing.ids] : []
    if (!ids.includes(taskId)) ids.push(taskId)
    this.runTasks.set(runId, { ids, expiresAt: now + ttlSeconds * 1_000 })
    if (!this.redis) return
    await this.redis
      .setJson(`ai:capability:run-tasks:${runId}`, ids, ttlSeconds)
      .catch((error: unknown) =>
        this.logger?.warn('capability.registry.run_task_persist_failed', {
          runId,
          reason: error instanceof Error ? error.message : String(error),
        }),
      )
  }

  /** 本轮发起过的任务 id（跨副本走 Redis；没有就返回空） */
  async runTaskIds(runId: string): Promise<string[]> {
    const local = this.runTasks.get(runId)
    if (local && local.expiresAt > Date.now()) return [...local.ids]
    if (!this.redis) return local?.ids ?? []
    const remote = await this.redis
      .getJson<string[]>(`ai:capability:run-tasks:${runId}`)
      .catch(() => null)
    return remote ?? local?.ids ?? []
  }

  async taskLocation(taskId: string): Promise<TaskLocation | null> {
    const local = this.tasks.get(taskId)
    if (local && local.expiresAt > Date.now()) return local.location
    if (!this.redis) return local?.location ?? null
    const remote = await this.redis
      .getJson<TaskLocation>(`ai:capability:task:${taskId}`)
      .catch(() => null)
    return remote ?? local?.location ?? null
  }

  async getService(name: string): Promise<RegisteredService | null> {
    await this.ensureLoaded()
    return this.services.get(name) ?? null
  }

  async snapshot(): Promise<RegisteredService[]> {
    await this.ensureLoaded()
    return [...this.services.values()]
  }

  private liveInstances(service: RegisteredService): RegisteredInstance[] {
    const cutoff = Date.now() - this.config.staleAfterMs
    return Object.values(service.instances).filter(
      (instance) => !instance.draining && instance.lastSeenAt >= cutoff,
    )
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loading) return this.loading
    this.loading = (async () => {
      // DB 优先（事实源）；DB 为空（迁移窗口）再用 Redis 快照兜底
      if (this.db) {
        const rows = await this.db
          .getRepository(AiCapabilityServiceEntity)
          .find()
          .catch(() => [])
        for (const row of rows) {
          const parsed = RegisteredServiceSchema.safeParse(row.snapshot)
          if (parsed.success) this.services.set(parsed.data.service, parsed.data)
        }
      }
      if (!this.redis) return
      if (this.services.size === 0) {
        const snapshot = await this.redis
          .getJson<{ services?: Record<string, unknown> }>(STORE_KEY)
          .catch((): { services?: Record<string, unknown> } | null => null)
        for (const raw of Object.values(snapshot?.services ?? {})) {
          const parsed = RegisteredServiceSchema.safeParse(raw)
          if (!parsed.success) continue
          this.services.set(parsed.data.service, parsed.data)
        }
      }
      const credentials = await this.redis
        .getJson<Record<string, string>>(CREDENTIALS_KEY)
        .catch((): Record<string, string> | null => null)
      for (const [service, credential] of Object.entries(credentials ?? {})) {
        this.credentials.set(service, credential)
      }
    })()
    return this.loading
  }

  private async persist(): Promise<void> {
    await this.persistDb()
    if (!this.redis) return
    await Promise.all([
      this.redis.setJson(STORE_KEY, { services: Object.fromEntries(this.services) }),
      this.redis.setJson(CREDENTIALS_KEY, Object.fromEntries(this.credentials)),
    ]).catch((error: unknown) => {
      this.logger?.warn('capability.registry.persist_failed', {
        reason: error instanceof Error ? error.message : String(error),
      })
    })
  }

  /** 目录落 DB：整条快照 upsert，退役的服务删行（登记表不需要软删历史） */
  private async persistDb(): Promise<void> {
    if (!this.db) return
    try {
      const repo = this.db.getRepository(AiCapabilityServiceEntity)
      const existing = await repo.find()
      const byService = new Map(existing.map((row) => [row.service, row]))
      const rows = [...this.services.values()].map((service) => ({
        // upsert 不走 `@BeforeInsert`，id 自己给（沿用已有行，避免换主键）
        id: byService.get(service.service)?.id ?? randomUUID().replace(/-/g, '').slice(0, 20),
        service: service.service,
        snapshot: service as unknown as Record<string, unknown>,
      }))
      // `snapshot` 是 jsonb 的任意对象，TypeORM 的 DeepPartial 泛型认不出它，这里退到 never
      if (rows.length > 0) await repo.upsert(rows as never, { conflictPaths: ['service'] })
      const keep = new Set(this.services.keys())
      const stale = existing.filter((row) => !keep.has(row.service))
      if (stale.length > 0) await repo.delete(stale.map((row) => row.id))
    } catch (error) {
      this.logger?.warn('capability.registry.db_persist_failed', {
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
