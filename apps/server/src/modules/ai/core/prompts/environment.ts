import { describePlatform, type PlatformInfo } from '@repo/kits'

/**
 * 「运行环境」提示词片段的数据（模板 `partials/environment.eta` 渲染它）。
 *
 * 为什么是**会话开局注入一次**而不是每轮都注入（用户口径 + 缓存代价）：
 * 系统提示词是整段请求的**前缀**，每轮都塞一个变化的时间戳，就会让提供方的
 * 前缀缓存（DeepSeek 的自动缓存命中）每轮都失效 —— 省不出钱也省不出延迟。
 * 开局注入 + 需要精确时间时用 `run-command` 自己取，是这两件事的平衡点。
 */
export type EnvironmentData = {
  /** 操作系统画像，如 `macOS 24.6.0（darwin / arm64）` */
  os: string
  /** 解释整条命令行的 shell（Windows `cmd.exe` / POSIX `/bin/sh`） */
  shell: string
  /** 本地时间（含时区与偏移），如 `2026年9月30日星期三 17:55:00（Asia/Shanghai，UTC+08:00）` */
  now: string
}

/** 进程所在时区（IE 时区库名，如 `Asia/Shanghai`）；拿不到就回落 `UTC`，不编造 */
const resolveTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * 本地时间（`dateStyle: full` + `timeStyle: medium`）：`2026年9月30日星期三 17:55:00`。
 *
 * 用 `Intl` 而不是手写补齐：星期、月日的中文写法由 ICU 给，三端一致；
 * 注入 `timeZone` 让单测能钉死输出（时间格式这种东西，靠"跑的时候正好是几点"断言等于没断言）。
 */
const formatLocalTime = (now: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'full',
    timeStyle: 'medium',
    timeZone,
    hour12: false,
  }).format(now)

/** 时区偏移（`UTC+08:00` / `UTC`）—— 同样由注入的时区推导，不读进程的 `getTimezoneOffset` */
const formatOffset = (now: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(now)
  const raw = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT'
  return raw.replace('GMT', 'UTC')
}

/**
 * 组装模板数据。三个入参都可注入（时间 / 平台画像 / 时区），因此**可单测**：
 * 跨平台代码不在别的系统上跑，就只能靠注入把三端取值都测一遍。
 */
export const buildEnvironmentData = (
  now: Date = new Date(),
  platform: PlatformInfo = describePlatform(),
  timeZone: string = resolveTimeZone(),
): EnvironmentData => ({
  os: platform.label,
  shell: platform.shell,
  now: `${formatLocalTime(now, timeZone)}（${timeZone}，${formatOffset(now, timeZone)}）`,
})
