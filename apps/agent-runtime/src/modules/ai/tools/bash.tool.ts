import { mkdir } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { Inject, Injectable, Optional, type OnApplicationBootstrap } from '@nestjs/common'
import { z } from 'zod'
import { AppLogger, WorkspaceRuntimeService, type WorkspaceExecResult } from '@repo/kits'
import { ToolDecl, ToolGroup } from '../core/tools/tool.decorator.js'
import { TOOL_KEYS } from '../core/tools/tool-keys.js'
import { BASH_TOOL } from '@repo/tool-catalog'
import { TOOL_ENV_CAPS } from '../core/tools/tool.config.ports.js'
import type { ToolCallContext, ToolEnvCaps } from '../core/tools/tools.types.js'
import {
  conversationWorkspace,
  resolveWorkspacePath,
  workspaceRoot,
} from '../core/tools/workspace.js'

/**
 * `bash` 的**参数定义**（给模型看的数据结构）。
 *
 * 两个字段刻意保持极简：命令、在哪个目录跑。
 * 时长与输出上限只由**配置**决定（库里可改，env 是硬上限），模型不能自己要求跑多久。
 */
/** **配置定义**：每个字段都必须有默认值（注册机在启动期用 `config.parse({})` 校验） */
const BashConfig = z.object({
  /** 能力级开关（配置表里还有一个治理级开关 `enabled`，两者都开才放行） */
  enabled: z.boolean().default(true),
  /** 单条命令的时长上限（ms）：配置值即硬上限，模型不能传时长 */
  timeoutMs: z.number().int().positive().default(300_000),
  /** 单条流（stdout / stderr 各自）的输出上限（字节）；超出即截断并终止命令 */
  maxOutputBytes: z
    .number()
    .int()
    .positive()
    .default(64 * 1024),
})

type BashConfigValue = z.infer<typeof BashConfig>

/** 信封里本工具用到的那几项（避免把整个信封类型铺进本文件） */
interface CommandEnvelopeLike {
  conversationId?: string
  workspaceConversationId?: string
  parentRunId?: string
  triggeredBy?: string | null
  /** 会话的文件权限（只读 / 可写）；缺省按可写处理 */
  fileAccess?: 'read-only' | 'workspace-write'
}

/**
 * **命令执行工具组**：一个组一个类，**组内一个方法一个工具**（设计 §5.2）。
 *
 * - 机制在基础设施统一入口（`@repo/kits` 的 `WorkspaceRuntimeService` → `CommandRunner` / 沙箱包装），
 *   本类只写**业务动作**；
 * - 依赖走构造器注入（`CommandRunner` / `AppLogger`）—— 与业务代码同一条 IoC 链路；
 * - 开关判断、目录边界、时长夹紧分别是声明里的 `precheck` / `normalize` 钩子（网关按声明调用），
 *   于是"同一类判断"在工程里只有一份实现，新工具不会漏写。
 *
 * 安全边界（**如实记录，不假装这是沙箱**）：命令以**服务进程的身份与权限**执行，
 * 能读写该身份能读写的一切。工程的取舍：由配置决定开不开、由 workdir 限制默认目录、
 * 由超时与输出上限兜住资源，且**每一次调用都完整入库**（时间线里的入参出参就是审计证据）。
 * 真要强隔离，得把执行放到容器 / 沙箱里（那是另一件事，不在本类里假装做到）。
 */
@Injectable()
@ToolGroup({
  category: 'core',
  scope: 'all',
  // 子 agent 也拿得到（它不是委派类工具）
  child: 'allow',
})
export class BashTool implements OnApplicationBootstrap {
  constructor(
    @Inject(WorkspaceRuntimeService) private readonly runtime: WorkspaceRuntimeService,
    @Inject(AppLogger) private readonly logger: AppLogger,
    /**
     * 部署边界（env）：只用来在启动时拿到 `AGENT_COMMAND_WORK_DIR`。
     *
     * `@Optional()`：单测与"不启用命令执行"的手工装配可以只传 runner / logger；
     * 容器装配时 AiModule 会注入。
     */
    @Optional() @Inject(TOOL_ENV_CAPS) private readonly caps?: ToolEnvCaps,
  ) {}

  /**
   * 启动时确保 AI 的工作根目录存在（`AGENT_COMMAND_WORK_DIR`）。
   *
   * 它既是 `bash` 的默认工作目录，也是 agent 新建文件 / 子目录的落点：
   * 根目录被删掉后，新建会话里模型的第一条命令就会因为 cwd 不存在而失败。
   * 这里按"部署能力"处理：目录建不出来只记错误，不拦整个服务启动。
   */
  async onApplicationBootstrap(): Promise<void> {
    const root = workspaceRoot(this.caps)
    try {
      await mkdir(root, { recursive: true })
      this.logger.log('ai.command.workspace_ready', { root })
    } catch (error) {
      this.logger.error('ai.command.workspace_unavailable', {
        root,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** **执行体**：只写业务动作（开关与边界已经在插件 / normalize 里判过） */
  @ToolDecl({
    key: TOOL_KEYS.bash,
    title: BASH_TOOL.title,
    // 声明会返回大结果：输出上限几十 KB，超了就给模型一页 + 取页句柄
    paginate: { pageBytes: 8 * 1024 },
    params: BASH_TOOL.params,
    config: BashConfig,
    precheck: 'checkWorkDir',
    normalize: 'normalizeConfig',
    description: BASH_TOOL.description,
  })
  async execute(
    input: z.infer<typeof BASH_TOOL.params>,
    ctx: ToolCallContext<BashConfigValue>,
  ): Promise<WorkspaceExecResult> {
    const envelope = (ctx.envelope as CommandEnvelopeLike | null) ?? null
    const conversationId = envelope?.conversationId ?? ctx.caller?.conversationId
    // 子会话共享根会话工作区；没有子会话时两者相等
    const workspaceConversationId =
      envelope?.workspaceConversationId ??
      envelope?.conversationId ??
      ctx.caller?.workspaceConversationId ??
      ctx.caller?.conversationId
    // 每个会话一个 workspace：根目录被删掉就（重新）建出来，避免每条命令都因 cwd 不存在失败。
    const workDir = conversationWorkspace(this.caps, workspaceConversationId)
    await mkdir(workDir, { recursive: true })
    const target = await resolveWorkspacePath({
      caps: this.caps,
      conversationId: workspaceConversationId,
      path: input.cwd ?? '.',
      allowMissing: true,
    })
    await mkdir(target, { recursive: true })
    const result = await this.runtime.exec({
      command: input.command,
      cwd: target,
      // 沙箱允许写的是**整个会话工作区**，不是命令的 cwd（cwd 可以是它的子目录）
      workspaceRoot: workDir,
      // 会话页选的文件权限（只读 / 可写）；逃不出沙箱
      fileAccess: envelope?.fileAccess ?? 'workspace-write',
      // 时长只由配置决定（normalize 已按 env 夹过），模型入参里没有这一项
      timeoutMs: ctx.settings.config.timeoutMs,
      maxOutputBytes: ctx.settings.config.maxOutputBytes,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })

    // 每次执行都留一条审计线索（完整入参出参另有时间线兜底）
    this.logger.info('ai.command.executed', {
      conversationId,
      workspaceConversationId,
      runId: envelope?.parentRunId,
      userId: envelope?.triggeredBy,
      command: input.command,
      cwd: result.cwd,
      exitCode: result.exitCode,
      ok: result.ok,
      timedOut: result.timedOut,
      aborted: result.aborted,
      truncated: result.truncated,
      durationMs: result.durationMs,
      runtime: result.runtime,
      mode: result.mode,
    })

    // 出参**原样返回**（运行时会把完整出参落时间线，不裁剪；分页只改给模型的那一份）
    return result
  }

  /**
   * **配置归一化**（纯函数）：把库里的值夹到**部署边界**（env）之内。
   *
   * 开关是"两边都开才放行"：`caps.command.enabled`（env）为 false 时，库里的 true 也不生效 ——
   * 于是既有部署的 `AGENT_COMMAND_ENABLED=false` 依然管用（谁也没法在页面上把它绕过去）。
   */
  normalizeConfig(config: BashConfigValue, caps: ToolEnvCaps): BashConfigValue {
    return {
      // 其余配置项原样保留：这里是"夹紧"，不是"瘦身"
      ...config,
      enabled: config.enabled && (caps.command?.enabled ?? true),
      timeoutMs: Math.min(config.timeoutMs, caps.command?.timeoutMsMax ?? config.timeoutMs),
      maxOutputBytes: Math.min(
        config.maxOutputBytes,
        caps.command?.maxOutputBytesMax ?? config.maxOutputBytes,
      ),
    }
  }

  /**
   * **只读前置条件**：工作目录必须在边界之内（越界**拒绝并说明**，不静默夹回）。
   *
   * 用 `path.relative` 判边界而不是字符串前缀：既天然处理 `..` 逃逸，
   * 也不会被 Windows 的大小写差异（`C:\Users` vs `c:\users`）误判。
   */
  checkWorkDir(
    input: z.infer<typeof BASH_TOOL.params>,
    ctx: ToolCallContext<BashConfigValue>,
  ): string | null {
    if (!input.cwd) return null
    const envelope = (ctx.envelope as CommandEnvelopeLike | null) ?? null
    const root = conversationWorkspace(
      this.caps,
      envelope?.workspaceConversationId ??
        envelope?.conversationId ??
        ctx.caller?.workspaceConversationId ??
        ctx.caller?.conversationId,
    )
    const target = resolve(root, input.cwd)
    const rel = relative(root, target)
    const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    if (inside) return null
    return `工作目录只能在本会话工作区之内（${root}），收到的是 ${input.cwd}`
  }
}
