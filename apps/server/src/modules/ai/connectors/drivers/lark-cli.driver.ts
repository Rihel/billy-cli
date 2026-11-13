import { Inject, Injectable } from '@nestjs/common'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { RedisLockService } from '@repo/kits'
import { ToolDeniedError } from '../../core/tools/tools.types.js'
import type {
  Capability,
  ConnectorDriver,
  ConnectorFieldDecl,
  ConnectorRuntime,
} from '../connector.types.js'
import { isLarkCliDomain, parseLarkCliArgs } from './lark-cli.policy.js'
import { ConnectorStateStore } from '../connector-state.store.js'
import { restoreHome, sameFiles, snapshotHome } from './lark-cli.home.js'

/**
 * **飞书 CLI 驱动（`lark-cli`）**（设计 `docs/design/ai-connector.md` §3.14）。
 *
 * lark-cli 不是"一组工具"，而是"**一个命令行 + 一堆内嵌技能文档**"：
 * - 能力面：只交一个受限的 `run` 工具（子命令 + 参数数组，`spawn` 直跑，**不走 shell**）；
 * - 文档面：技能内嵌在 CLI 二进制里，模型用 `["skills","list"]` / `["skills","read","lark-im"]`
 *   自己查用法（我们没有把二十多份 SKILL.md 塞进系统提示词，省 token）；
 * - 运维面：App ID / App Secret 来自连接器实例，**每个实例一个独立 HOME**，
 *   写进 `<HOME>/.lark-cli/config.json`，互不串号；删连接器时整目录删掉。
 * - **无状态 pod**：HOME 是临时目录，配置 / 用户 token 存在 `ai_connectors.auth_state`；
 *   调用前 hydrate 到 HOME、调用后 diff 写回（实例级 Redis 锁串行化）。
 *
 * 三条边界（改代码前先读）：
 * 1. 命令白名单在 `lark-cli.policy.ts`，页面改不了；
 * 2. 子进程环境变量走白名单，不把服务端的密钥 / 数据库连接串带进去；
 * 3. 工作目录固定为实例 HOME，CLI 产生的文件不会写进应用目录。
 *
 * 为什么不复用 kits 的 `CommandRunner`：它是 `shell: true` 的执行口径，
 * 而这条链路必须"参数数组直传、不经过 shell"（否则模型给的一个字符串就可能拼出管道）。
 */

/** 与 `Dockerfile.server` 预装的包对应；驱动不负责运行时安装（容器里没有 root / 也不该联网装包） */
const BINARY = 'lark-cli'

/** 单次调用最多读多少字节（超出即终止；工具网关另有分页） */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024

/** `config init` 走一次网络校验，单独给 20 秒（比业务调用更宽） */
const INIT_TIMEOUT_MS = 20_000

/** 探活用 `doctor`，最多等 20 秒（它内部要查网络与授权状态） */
const PROBE_TIMEOUT_MS = 20_000

/** 配置：每个字段都要有默认值（`config.parse({})` 必须成功，注册机启动期会校验） */
const LarkCliConfig = z.object({
  /** 飞书应用的 App ID（不是密钥，可以明文展示） */
  appId: z.string().trim().default(''),
  /** 国内飞书=`feishu`，国际版=`lark` */
  brand: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(['feishu', 'lark']))
    .default('feishu'),
  /** 默认身份：auto（有用户授权就用户，否则应用）/ user / bot */
  identity: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(['auto', 'user', 'bot']))
    .default('auto'),
  /** 单次命令的超时（毫秒） */
  timeoutMs: z.number().int().positive().max(120_000).default(30_000),
})

type LarkCliConfigValue = z.infer<typeof LarkCliConfig>

/** `run` 的入参：参数数组而不是一整条命令串——从形状上就堵住 shell 拼接 */
const RUN_INPUT = {
  type: 'object',
  properties: {
    args: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 32,
      description:
        '子命令与参数数组，如 ["skills","list"]、["im","+messages-send","--chat-id","oc_xxx","--text","你好"]；不含 lark-cli 本身',
    },
  },
  required: ['args'],
} as const

const RUN_DESCRIPTION = [
  '执行飞书官方 lark-cli（参数数组直跑，不走 shell）。',
  '第一次用先读技能：["skills","list"] 看业务域，["skills","read","lark-im"] 读该域的命令与参数；',
  '也可 ["schema","im.messages.create"] 查接口、["im","--help"] 查用法。',
  '允许消息 / 文档 / 多维表格 / 表格 / 日历 / 邮件 / 任务等业务域；禁止 config、api、profile、update、auth logout。',
  '未授权时用 ["auth","login","--no-wait","--json"] 取验证链接，用户完成后用 ["auth","login","--device-code","<code>"] 收尾。',
  '不要传 --profile / --yes；业务命令默认输出 JSON。',
].join(' ')

/** 驱动执行一次子进程的结果（不抛异常，失败在字段里表达，便于统一翻译成工具结论） */
interface ExecOutcome {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  overflow: boolean
  spawnError: string | null
}

/** 我们在实例 HOME 里留的状态文件：只记指纹，不存密钥（密钥在 CLI 自己的加密配置里） */
interface PreparedState {
  fingerprint: string
  appId: string
  brand: string
  updatedAt: string
}

/** 实例 HOME 的根：容器里是 `/home/appuser/.billy/lark-cli`，本地开发是 `~/.billy/lark-cli` */
const homeRoot = (): string => join(homedir(), '.billy', 'lark-cli')

const stateFileOf = (dir: string): string => join(dir, '.billy-prepared.json')

/** 指纹变了就重跑 `config init`（App ID / Secret / brand 任一变化） */
const fingerprintOf = (appId: string, secret: string, brand: string): string =>
  createHash('sha256').update(`${appId}\u0000${secret}\u0000${brand}`).digest('hex').slice(0, 32)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 严格解析：成功输出通常是纯 JSON */
const parseJsonStrict = (text: string): unknown => {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/**
 * 宽松解析：CLI 有时会在 JSON 前打一行提示（如 `config init` 的 `OK: ...`），
 * 这里从第一个 `{` 到最后一个 `}` 再试一次。只用于错误信封与 `doctor` 输出。
 */
const parseJsonLoose = (text: string): unknown => {
  const strict = parseJsonStrict(text)
  if (strict !== undefined) return strict
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/** 从 CLI 的 `{ ok: false, error: { message, hint } }` 里取可纠正的结论 */
const errorEnvelopeOf = (text: string): { message: string; hint?: string } | null => {
  const value = parseJsonLoose(text)
  if (!isRecord(value) || value.ok !== false) return null
  const error = isRecord(value.error) ? value.error : null
  if (!error || typeof error.message !== 'string') return null
  return {
    message: error.message,
    hint: typeof error.hint === 'string' ? error.hint : undefined,
  }
}

/** 一行可读的错误摘要（日志 / 工具结论里不要贴整段 stderr） */
const compact = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 600)

/** 子进程环境变量白名单：不带服务端的任何密钥 */
const childEnv = (home: string): NodeJS.ProcessEnv => {
  const keys = [
    'PATH',
    'LANG',
    'LC_ALL',
    'LANGUAGE',
    'TZ',
    'TMPDIR',
    'TEMP',
    'TMP',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
  ]
  const env: NodeJS.ProcessEnv = { HOME: home, LANG: process.env.LANG ?? 'C.UTF-8' }
  for (const key of keys) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin'
  return env
}

@Injectable()
export class LarkCliDriver implements ConnectorDriver {
  readonly kind = 'lark-cli'
  readonly transport = 'process' as const
  readonly config = LarkCliConfig
  readonly secrets: readonly ConnectorFieldDecl[] = [
    {
      key: 'appSecret',
      label: 'App Secret',
      type: 'password',
      secret: true,
      required: true,
      help: '飞书开放平台应用的 App Secret；只写进该实例自己的 CLI 配置，接口不会回显',
    },
  ]
  readonly auth = { base: 'install+secret' as const, subject: 'cli-login' as const }

  /** 同一个实例的首次 `config init` 只跑一次（并发调用共享同一个 promise） */
  private readonly preparing = new Map<string, Promise<void>>()
  /** 本进程内已 hydrate 到的状态版本（避免每次都解包文件） */
  private readonly localVersion = new Map<string, number>()
  /** 上次写回 / hydrate 的快照（调用后 diff 用） */
  private readonly lastSnapshot = new Map<string, Record<string, string>>()

  constructor(
    @Inject(ConnectorStateStore) private readonly states: ConnectorStateStore,
    @Inject(RedisLockService) private readonly locks: RedisLockService,
  ) {}

  async describe(): Promise<Capability[]> {
    return [
      {
        kind: 'tool',
        name: 'run',
        title: '执行飞书命令',
        description: RUN_DESCRIPTION,
        inputSchema: RUN_INPUT,
        risk: 'write',
      },
    ]
  }

  async invoke(rt: ConnectorRuntime, tool: string, input: unknown): Promise<unknown> {
    if (tool !== 'run') {
      throw new ToolDeniedError('unknown-tool', `驱动 ${this.kind} 没有工具 ${tool}`)
    }

    const args = parseLarkCliArgs(input)
    const config = LarkCliConfig.parse(rt.config)

    return this.withState(rt, async () => {
      await this.prepareOnce(rt, config)
      const finalArgs = this.withIdentity(args, config)
      const outcome = await this.exec(rt, finalArgs, config.timeoutMs)
      return this.toToolOutput(outcome, config.timeoutMs)
    })
  }

  async probe(rt: ConnectorRuntime): Promise<{ ok: boolean; message?: string }> {
    const config = LarkCliConfig.parse(rt.config)
    try {
      return await this.withState(rt, async () => {
        try {
          await this.prepareOnce(rt, config)
        } catch (error) {
          return { ok: false, message: messageOf(error) }
        }

        const outcome = await this.exec(
          rt,
          ['doctor'],
          Math.min(config.timeoutMs, PROBE_TIMEOUT_MS),
        )

        if (outcome.spawnError) {
          return { ok: false, message: `未找到 ${BINARY}（${outcome.spawnError}）` }
        }
        if (outcome.aborted) return { ok: false, message: '这次检查被取消' }
        if (outcome.timedOut) {
          return {
            ok: false,
            message: `lark-cli doctor 超过 ${PROBE_TIMEOUT_MS / 1000} 秒未结束`,
          }
        }

        const report = parseJsonLoose(outcome.stdout)
        const checks = isRecord(report) && Array.isArray(report.checks) ? report.checks : []
        const failed = checks.find(
          (check) =>
            isRecord(check) && check.status === 'fail' && typeof check.message === 'string',
        )

        if (outcome.code === 0) {
          const ready = checks.find((check) => isRecord(check) && check.name === 'identity_ready')
          const detail = isRecord(ready) && typeof ready.message === 'string' ? ready.message : null
          return { ok: true, message: detail ? `身份可用：${detail}` : undefined }
        }

        const envelope = errorEnvelopeOf(outcome.stderr) ?? errorEnvelopeOf(outcome.stdout)
        if (envelope) return { ok: false, message: envelope.message }

        if (isRecord(failed)) {
          const hint = typeof failed.hint === 'string' ? `（${failed.hint}）` : ''
          return { ok: false, message: `${String(failed.name)}: ${String(failed.message)}${hint}` }
        }

        const summary = compact(outcome.stderr || outcome.stdout)
        return {
          ok: false,
          message: summary || `lark-cli doctor 退出码 ${outcome.code ?? '未知'}`,
        }
      })
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    }
  }

  /** 删连接器时把实例 HOME（配置 / 用户 token / 下载缓存）一起删掉 */
  async dispose(instanceId: string): Promise<void> {
    this.preparing.delete(instanceId)
    this.localVersion.delete(instanceId)
    this.lastSnapshot.delete(instanceId)
    // token 不在库里留：删连接器时连授权状态一起清
    await this.states.clear(instanceId).catch(() => undefined)
    await rm(this.homeDir(instanceId), { recursive: true, force: true })
  }

  /**
   * 在**实例级锁**里跑一次调用，并把 CLI 的 HOME 状态在「库 ↔ 磁盘」之间同步。
   *
   * 为什么整个调用都要持锁：token 是 CLI 在命令内部刷新的，我们没法只锁"刷新"那一下；
   * 只能把同一连接器的调用串行化，避免两个 pod 各自刷新、互相覆盖。飞书调用量不大，代价可接受。
   */
  private async withState<T>(rt: ConnectorRuntime, run: () => Promise<T>): Promise<T> {
    const lockKey = `connector:lark:${rt.instanceId}`
    let token: string
    try {
      token = await this.locks.lock(lockKey, 120, 10)
    } catch {
      throw new ToolDeniedError(
        'rate-limited',
        '这个连接器正在被另一个调用占用，请稍后重试',
        '同一连接器的飞书调用是串行的；等前一个调用结束后再试',
        true,
      )
    }

    let hydrated = false
    try {
      await this.hydrate(rt.instanceId)
      hydrated = true
      return await run()
    } finally {
      // 调用失败也要写回：token 可能已经在命令内部刷新了；
      // 但 hydrate 失败（库不可用）时**不能**写回，否则会拿空的 HOME 覆盖库里的授权
      if (hydrated) await this.persist(rt.instanceId).catch(() => undefined)
      await this.locks.unlock(lockKey, token).catch(() => false)
    }
  }

  /** 从库恢复 HOME（版本没变就跳过，避免每次调用都解包文件） */
  private async hydrate(instanceId: string): Promise<void> {
    const state = await this.states.load(instanceId)
    if (!state) return
    if (this.localVersion.get(instanceId) === state.version) return
    await restoreHome(this.homeDir(instanceId), state.files)
    this.localVersion.set(instanceId, state.version)
    this.lastSnapshot.set(instanceId, state.files)
  }

  /** 把 HOME 的变化写回库（内容没变就不写；版本冲突时重读一次再写） */
  private async persist(instanceId: string): Promise<void> {
    const files = await snapshotHome(this.homeDir(instanceId))
    if (sameFiles(files, this.lastSnapshot.get(instanceId) ?? null)) return

    const expected = this.localVersion.get(instanceId) ?? 0
    let version = await this.states.save(instanceId, files, expected)
    if (version === null) {
      // 别的实例先写了一步：以库里的最新版本为基准再写一次（授权动作罕见，后写覆盖可接受）
      const latest = await this.states.load(instanceId)
      version = await this.states.save(instanceId, files, latest?.version ?? 0)
    }
    if (version === null) return
    this.localVersion.set(instanceId, version)
    this.lastSnapshot.set(instanceId, files)
  }

  /** 首次调用前把 App 凭证写进该实例自己的 CLI 配置（幂等：指纹没变就跳过） */
  private prepareOnce(rt: ConnectorRuntime, config: LarkCliConfigValue): Promise<void> {
    const existing = this.preparing.get(rt.instanceId)
    if (existing) return existing

    const task = this.configure(rt, config).finally(() => {
      this.preparing.delete(rt.instanceId)
    })
    this.preparing.set(rt.instanceId, task)
    return task
  }

  private async configure(rt: ConnectorRuntime, config: LarkCliConfigValue): Promise<void> {
    const dir = this.homeDir(rt.instanceId)
    await mkdir(dir, { recursive: true, mode: 0o700 })

    const appId = config.appId.trim()
    const secret = (rt.secrets.appSecret ?? '').trim()
    if (!appId) {
      throw new ToolDeniedError(
        'precheck-failed',
        '连接器还没填 App ID',
        '在后台「AI → 连接器」补全 App ID / App Secret，再点「测试」',
      )
    }
    if (!secret) {
      throw new ToolDeniedError(
        'precheck-failed',
        '连接器还没填 App Secret',
        '在后台「AI → 连接器」补全 App Secret，再点「测试」',
      )
    }

    const fingerprint = fingerprintOf(appId, secret, config.brand)
    const prepared = await this.readState(dir)
    if (prepared?.fingerprint === fingerprint) return

    const outcome = await this.exec(
      rt,
      [
        'config',
        'init',
        '--app-id',
        appId,
        '--brand',
        config.brand,
        '--app-secret-stdin',
        '--force-init',
      ],
      INIT_TIMEOUT_MS,
      secret,
    )

    // 只有 CLI 真的把 appId 落盘了才记指纹：装都没装 / 超时的情况不能记，
    // 否则下次会跳过 config init，拿着空配置去执行。
    const savedAppId = await this.readCliAppId(dir)
    if (savedAppId === appId) {
      await this.writeState(dir, {
        fingerprint,
        appId,
        brand: config.brand,
        updatedAt: new Date().toISOString(),
      }).catch(() => undefined)
    }

    if (outcome.spawnError) {
      throw new ToolDeniedError(
        'precheck-failed',
        `无法执行 ${BINARY}：${outcome.spawnError}`,
        'server 镜像默认已装 lark-cli；本地开发先 npm i -g @larksuite/cli，或检查 PATH',
      )
    }
    if (outcome.timedOut) {
      throw new ToolDeniedError(
        'timeout',
        `lark-cli config init 超过 ${INIT_TIMEOUT_MS / 1000} 秒未完成`,
        '检查服务器到飞书开放平台的网络',
      )
    }
    if (outcome.code !== 0) {
      const envelope = errorEnvelopeOf(outcome.stderr) ?? errorEnvelopeOf(outcome.stdout)
      throw new ToolDeniedError(
        'precheck-failed',
        envelope
          ? `飞书应用凭证校验失败：${envelope.message}`
          : `lark-cli config init 失败：${compact(outcome.stderr || outcome.stdout)}`,
        envelope?.hint ?? '检查 App ID / App Secret 是否属于同一个飞书应用',
      )
    }
  }

  /** 按配置追加默认身份（只对业务域命令；`--as` 已由模型显式给出时不重复） */
  private withIdentity(args: string[], config: LarkCliConfigValue): string[] {
    if (config.identity === 'auto') return args
    if (!isLarkCliDomain(args[0])) return args
    if (args.includes('--as')) return args
    return [...args, '--as', config.identity]
  }

  /**
   * 跑一次子进程（参数数组直传，不经过 shell）。
   *
   * 为什么用 `spawn` 而不是 `execFile`：`lark-cli` 是 npm 的 Node wrapper，它再 spawn Go 二进制；
   * 只杀 wrapper 会把 Go 子进程留成孤儿。这里用 `detached` 起独立进程组，超时 / 取消时按组杀
   * （Windows 上退回只杀 wrapper）。输出上限、超时、取消都在这一层收口。
   */
  private exec(
    rt: ConnectorRuntime,
    args: string[],
    timeoutMs: number,
    stdin?: string,
  ): Promise<ExecOutcome> {
    const dir = this.homeDir(rt.instanceId)

    return new Promise((resolve) => {
      let settled = false
      let timedOut = false
      let aborted = false
      let overflow = false
      let spawnError: string | null = null
      let stdout = ''
      let stderr = ''
      let stdoutBytes = 0
      let stderrBytes = 0

      const child = spawn(BINARY, args, {
        cwd: dir,
        env: childEnv(dir),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: true,
      })

      const killGroup = (): void => {
        if (!child.pid) return
        try {
          // 负 pid = 整个进程组（wrapper + Go 二进制）
          if (process.platform === 'win32') child.kill('SIGKILL')
          else process.kill(-child.pid, 'SIGKILL')
        } catch {
          try {
            child.kill('SIGKILL')
          } catch {
            // 已经退出
          }
        }
      }

      const finish = (code: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        rt.signal?.removeEventListener('abort', onAbort)
        resolve({ code, stdout, stderr, timedOut, aborted, overflow, spawnError })
      }

      const onAbort = (): void => {
        aborted = true
        killGroup()
      }

      const timer = setTimeout(() => {
        timedOut = true
        killGroup()
      }, timeoutMs)

      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')

      const append = (target: 'stdout' | 'stderr', chunk: string): void => {
        const bytes = Buffer.byteLength(chunk, 'utf8')
        const current = target === 'stdout' ? stdoutBytes : stderrBytes
        if (current + bytes > MAX_OUTPUT_BYTES) {
          overflow = true
          killGroup()
          return
        }
        if (target === 'stdout') {
          stdout += chunk
          stdoutBytes += bytes
        } else {
          stderr += chunk
          stderrBytes += bytes
        }
      }

      child.stdout?.on('data', (chunk: string) => append('stdout', chunk))
      child.stderr?.on('data', (chunk: string) => append('stderr', chunk))

      child.on('error', (error) => {
        const errno = error as NodeJS.ErrnoException
        spawnError = `${errno.code ?? errno.name}: ${errno.message}`
        finish(null)
      })
      child.on('close', (code) => finish(code))

      rt.signal?.addEventListener('abort', onAbort, { once: true })
      if (rt.signal?.aborted) onAbort()

      if (stdin !== undefined) {
        child.stdin?.on('error', () => undefined)
        child.stdin?.end(stdin)
      } else {
        // 没有输入就立刻 EOF：避免 CLI 以为还在等管道输入
        child.stdin?.end()
      }
    })
  }

  /** 子进程结果 → 模型能据此改口的工具结论 */
  private toToolOutput(outcome: ExecOutcome, timeoutMs: number): unknown {
    if (outcome.spawnError) {
      throw new ToolDeniedError(
        'precheck-failed',
        `无法执行 ${BINARY}：${outcome.spawnError}`,
        'server 镜像默认已装 lark-cli；本地开发先 npm i -g @larksuite/cli，或检查 PATH',
      )
    }
    if (outcome.aborted) {
      throw new ToolDeniedError('aborted', '这次调用被取消')
    }
    if (outcome.timedOut) {
      throw new ToolDeniedError(
        'timeout',
        `lark-cli 超过 ${Math.round(timeoutMs / 1000)} 秒未结束`,
        '缩小命令范围（加 --page-limit / --jq，或更精确的参数）后重试',
        true,
      )
    }
    if (outcome.overflow) {
      throw new ToolDeniedError(
        'upstream',
        `lark-cli 输出超过 ${MAX_OUTPUT_BYTES / 1024 / 1024}MB 被终止`,
        '用 --jq / --page-limit 收窄输出，或先读技能文档确认用法',
      )
    }

    const envelope = errorEnvelopeOf(outcome.stderr) ?? errorEnvelopeOf(outcome.stdout)
    if (outcome.code !== 0) {
      if (envelope) {
        throw new ToolDeniedError('upstream', envelope.message, envelope.hint)
      }
      throw new ToolDeniedError(
        'upstream',
        `lark-cli 退出码 ${outcome.code ?? '未知'}：${compact(outcome.stderr || outcome.stdout)}`,
      )
    }

    const json = parseJsonStrict(outcome.stdout)
    if (isRecord(json) && json.ok === false) {
      const failed = errorEnvelopeOf(outcome.stdout)
      throw new ToolDeniedError('upstream', failed?.message ?? 'lark-cli 返回失败', failed?.hint)
    }
    if (json !== undefined) return json

    // 非 JSON 输出（如 `skills read` 的 Markdown）原样交回；分页由工具网关负责
    const stdout = outcome.stdout.trim()
    const stderr = outcome.stderr.trim()
    if (!stdout) return { ok: true, ...(stderr ? { stderr } : {}) }
    return { stdout, ...(stderr ? { stderr } : {}) }
  }

  /** 实例 HOME（`instanceId` 来自数据库，这里再做一次越界校验） */
  private homeDir(instanceId: string): string {
    const root = homeRoot()
    const dir = join(root, instanceId)
    const rel = relative(root, dir)
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep + '..')) {
      throw new Error(`非法的连接器实例 id: ${instanceId}`)
    }
    return dir
  }

  /** 读 lark-cli 自己的配置文件里的 appId（只用来判断 init 有没有落盘，不读 secret） */
  private async readCliAppId(dir: string): Promise<string | null> {
    try {
      const raw = JSON.parse(
        await readFile(join(dir, '.lark-cli', 'config.json'), 'utf8'),
      ) as unknown
      if (!isRecord(raw)) return null
      // 真实结构是 `{ apps: [{ appId, ... }] }`；旧版本可能是扁平的 `{ appId }`
      const apps = Array.isArray(raw.apps) ? raw.apps.filter(isRecord) : []
      const value = apps[0]?.appId ?? raw.appId
      return typeof value === 'string' ? value : null
    } catch {
      return null
    }
  }

  private async readState(dir: string): Promise<PreparedState | null> {
    try {
      const raw = JSON.parse(await readFile(stateFileOf(dir), 'utf8')) as unknown
      if (!isRecord(raw) || typeof raw.fingerprint !== 'string') return null
      return {
        fingerprint: raw.fingerprint,
        appId: typeof raw.appId === 'string' ? raw.appId : '',
        brand: typeof raw.brand === 'string' ? raw.brand : '',
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
      }
    } catch {
      return null
    }
  }

  private async writeState(dir: string, state: PreparedState): Promise<void> {
    await writeFile(stateFileOf(dir), `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
