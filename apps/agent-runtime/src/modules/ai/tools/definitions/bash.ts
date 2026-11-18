import dedent from 'dedent'
import { z } from 'zod'

/** `bash` 的参数（给模型看的数据结构；也是 server 声明与 gateway manifest 的唯一来源） */
export const BashParams = z.object({
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
    .describe(
      '工作目录（相对默认工作目录，或它的子目录的绝对路径）；省略即用默认工作目录。**不允许跑到工作目录之外**',
    ),
})

export const BASH_TOOL = {
  key: 'bash',
  title: '执行 bash 命令',
  category: 'core',
  scope: 'all',
  executor: 'worker',
  version: 1,
  params: BashParams,
  description: dedent`
    在本机执行一条命令行命令（当前系统的 shell：Linux / macOS 是 /bin/sh，Windows 是 cmd.exe），
    拿到退出码、stdout 与 stderr。

    什么时候用：答案**只能靠真实执行**得到（跑脚本 / 测试、计算、取当前时间）。

    什么时候不用：能直接回答的、要用户拍板的、需要持续输入的。

    **不要读平台源码、配置、密钥、环境变量或数据库**：不属于用户任务。
    **默认关闭**（未显式设 \`AGENT_COMMAND_ENABLED=true\` 时返回"已被关闭"）。

    执行环境：命令在**沙箱**里跑，只能访问本会话工作区（会话页可切"只读 / 可写"）；
    沙箱不可用时会**拒绝执行**，实际以出参 \`runtime\` 为准。

    约束：命令要**幂等**；输出用管道 \`head\` / \`grep\` 收窄。
  `,
} as const
