import { arch, release } from 'node:os'

/**
 * 平台信息：**跨平台能力的唯一事实源**（命令执行、环境描述都从这里取）。
 *
 * 为什么单拎一个文件、且全部走 Node 的 `os` / `process`：
 * 取「操作系统与版本」不能靠 shell 命令 —— `uname` 在 Windows 上不存在，
 * `ver` 在 POSIX 上不存在，`process.platform` / `os.release()` 才是三端一致的口径。
 */

/** 已认识的平台 → 展示名；没见过的平台原样显示 `process.platform`（不编造） */
const PLATFORM_LABELS: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
  freebsd: 'FreeBSD',
  openbsd: 'OpenBSD',
  sunos: 'SunOS',
  aix: 'AIX',
}

/**
 * 该平台执行**整条命令行**用的 shell。
 *
 * - Windows：`%ComSpec%`（通常 `C:\Windows\System32\cmd.exe`），Node 的 `exec` 在 win32 下
 *   就是用它，并按 `cmd.exe /d /s /c "<command>"` 调用；
 * - 其余平台：`/bin/sh`（Node 的默认值，POSIX 保证存在）。
 *
 * 显式解析而不是不传（不传也能跑）：命令执行的**审计日志与出参**里要写清"这条命令是被谁解释的"，
 * 出问题时才能解释"为什么 `dir` 在 Linux 上失败"。
 */
export const resolveShell = (
  platform: NodeJS.Platform = process.platform,
): string => (platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh')

/** 平台画像（注入提示词 / 写审计日志用） */
export interface PlatformInfo {
  /** Node 的 `process.platform`（darwin / win32 / linux …） */
  platform: NodeJS.Platform
  /** 系统 / 内核版本（如 macOS 的 `24.6.0`、Windows 的 `10.0.22631`） */
  release: string
  /** CPU 架构（`arm64` / `x64` …） */
  arch: string
  /** 整条命令行由谁解释（见 {@link resolveShell}） */
  shell: string
  /** 人类 + 模型都能读的一句话：`macOS 24.6.0（darwin / arm64）` */
  label: string
}

/**
 * 平台画像。三个入参都可注入 —— 单测据此覆盖 Windows / Linux / macOS 三种取值，
 * 不必真的跑在三种系统上（跨平台代码不测另外两端，等于没测）。
 */
export const describePlatform = (
  platform: NodeJS.Platform = process.platform,
  systemRelease: string = release(),
  cpuArch: string = arch(),
): PlatformInfo => {
  const name = PLATFORM_LABELS[platform] ?? platform
  return {
    platform,
    release: systemRelease,
    arch: cpuArch,
    shell: resolveShell(platform),
    label: `${name} ${systemRelease}（${platform} / ${cpuArch}）`,
  }
}
