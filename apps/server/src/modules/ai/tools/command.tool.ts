import { isAbsolute, relative, resolve } from 'node:path'
import dedent from 'dedent'
import { Inject, Injectable } from '@nestjs/common'
import { z } from 'zod'
import { AppLogger, CommandRunner, type CommandResult } from '@repo/kits'
import { ToolDecl, ToolGroup } from '../core/tools/tool.decorator.js'
import { TOOL_KEYS } from '../core/tools/tool-keys.js'
import type { ToolCallContext, ToolEnvCaps } from '../core/tools/tools.types.js'

/**
 * `run-command` 的**参数契约**（给模型看的契约）。
 *
 * 三个字段刻意保持极简：命令、在哪个目录跑、最多跑多久。
 * 上限（时长 / 输出）由**配置**再夹一次（库里可改，env 是硬上限），模型传什么都不越界。
 */
const RunCommandParams = z.object({
  command: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      `要执行的**整条命令行**，按当前操作系统的 shell 语法书写（Windows 是 cmd.exe：\`dir\`；Linux/macOS 是 /bin/sh：\`ls -la\`）。不支持需要持续输入的交互式命令（没有 stdin）。`,
    ),
  cwd: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe('工作目录（相对默认工作目录，或它的子目录的绝对路径）；省略即用默认工作目录。**不允许跑到工作目录之外**'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(120_000)
    .optional()
    .describe('这次命令最多等多久（毫秒）；省略用服务端默认值（超过服务端上限会被夹到上限）'),
})

/** **配置契约**：每个字段都必须有默认值（注册机在启动期用 `config.parse({})` 校验） */
const RunCommandConfig = z.object({
  /** 能力级开关（配置表里还有一个治理级开关 `enabled`，两者都开才放行） */
  enabled: z.boolean().default(true),
  /** 单条命令的时长**默认值与硬上限**（ms）：模型传更小就听它的，传更大一律夹到这里 */
  timeoutMs: z.number().int().positive().default(15_000),
  /** 单条流（stdout / stderr 各自）的输出上限（字节）；超出即截断并终止命令 */
  maxOutputBytes: z.number().int().positive().default(64 * 1024),
  /** 命令的工作根目录（空 = 服务进程工作目录）；agent 传入的 `cwd` 只能在这个目录之内 */
  workDir: z.string().default(''),
})

type RunCommandConfigValue = z.infer<typeof RunCommandConfig>

/** 信封里本工具用到的那几项（避免把整个信封类型铺进本文件） */
interface CommandEnvelopeLike {
  conversationId?: string
  parentRunId?: string
  triggeredBy?: string | null
}

/**
 * **命令执行工具组**：一个组一个类，**组内一个方法一个工具**（设计 §5.2）。
 *
 * - 机制在基础设施门面（`@repo/kits` 的 `CommandRunner`，底层 execa），本类只写**业务动作**；
 * - 依赖走构造器注入（`CommandRunner` / `AppLogger`）—— 与业务代码同一条 IoC 链路；
 * - 开关判断、目录边界、时长夹紧分别是声明里的 `precheck` / `normalize` 钩子（网关按声明调用），
 *   于是"同一类判断"在工程里只有一份实现，新工具不会漏写。
 *
 * 安全边界（**如实记录，不假装这是沙箱**）：命令以**服务进程的身份与权限**执行，
 * 能读写该身份能读写的一切。工程的取舍：由配置决定开不开、由 workdir 限制默认落点、
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
export class RunCommandTool {
  constructor(
    @Inject(CommandRunner) private readonly runner: CommandRunner,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /** **执行体**：只写业务动作（开关与边界已经在插件 / normalize 里判过） */
  @ToolDecl({
    key: TOOL_KEYS.runCommand,
    title: '执行命令行命令',
    // 声明会返回大结果：输出上限几十 KB，超了就给模型一页 + 取页句柄
    paginate: { pageBytes: 8 * 1024 },
    params: RunCommandParams,
    config: RunCommandConfig,
    precheck: 'checkWorkDir',
    normalize: 'normalizeConfig',
    description: dedent`
      在本机执行一条命令行命令，拿到退出码、stdout 与 stderr。

      什么时候用：答案**只能靠真实执行**得到的事（看目录与文件、跑脚本或测试、查版本与环境、
      做一次计算、取当前时间）；命令按**运行环境里那个操作系统**的 shell 语法写
      （Windows 是 \`cmd.exe\`，Linux/macOS 是 \`/bin/sh\`），环境不确定就先用它查（\`whoami\`、\`pwd\` 之类）。

      什么时候不用：能从已知信息直接回答的、需要用户拍板才能改的、
      需要持续输入或长时间挂着的（没有 stdin，会被超时终止）。

      约束：\`cwd\` 只能在工作根目录之内（越界会被拒绝）；命令要**幂等、可重复**；
      输出可能很大，用管道 \`head\` / \`grep\` 或只列需要的字段收窄。
    `,
  })
  async execute(
    input: z.infer<typeof RunCommandParams>,
    ctx: ToolCallContext<RunCommandConfigValue>,
  ): Promise<CommandResult> {
    const envelope = (ctx.envelope as CommandEnvelopeLike | null) ?? null
    const workDir = resolve(ctx.settings.config.workDir || process.cwd())
    const target = resolve(workDir, input.cwd ?? '.')
    const result = await this.runner.run({
      command: input.command,
      cwd: target,
      // 配置里的时长既是**默认值**也是**硬上限**（normalize 已按 env 夹过）
      timeoutMs: Math.min(
        input.timeout_ms ?? ctx.settings.config.timeoutMs,
        ctx.settings.config.timeoutMs,
      ),
      maxOutputBytes: ctx.settings.config.maxOutputBytes,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })

    // 每次执行都留一条审计线索（完整入参出参另有时间线兜底）
    this.logger.info('ai.command.executed', {
      conversationId: envelope?.conversationId,
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
  normalizeConfig(config: RunCommandConfigValue, caps: ToolEnvCaps): RunCommandConfigValue {
    return {
      enabled: config.enabled && (caps.command?.enabled ?? true),
      timeoutMs: Math.min(config.timeoutMs, caps.command?.timeoutMsMax ?? config.timeoutMs),
      maxOutputBytes: Math.min(
        config.maxOutputBytes,
        caps.command?.maxOutputBytesMax ?? config.maxOutputBytes,
      ),
      workDir: config.workDir.trim() || caps.command?.workDir?.trim() || '',
    }
  }

  /**
   * **只读前置条件**：工作目录必须在边界之内（越界**拒绝并说明**，不静默夹回）。
   *
   * 用 `path.relative` 判边界而不是字符串前缀：既天然处理 `..` 逃逸，
   * 也不会被 Windows 的大小写差异（`C:\Users` vs `c:\users`）误判。
   */
  checkWorkDir(
    input: z.infer<typeof RunCommandParams>,
    ctx: ToolCallContext<RunCommandConfigValue>,
  ): string | null {
    if (!input.cwd) return null
    const root = resolve(ctx.settings.config.workDir || process.cwd())
    const target = resolve(root, input.cwd)
    const rel = relative(root, target)
    const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    if (inside) return null
    return `工作目录只能在工作根目录之内（${root}），收到的是 ${input.cwd}`
  }
}
