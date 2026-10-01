/**
 * 数字格式化（纯函数，便于单测）。
 *
 * 为什么要单独一处：token 数量动辄上万，`3179` 这种原始数字排一排既难读也撑破输入框底栏；
 * 统计行统一走这里 → k / m 缩写 + 悬停看精确值（`exactNumberText`）。
 */

/**
 * 紧凑数字：`3179` → `3.2k`、`1250000` → `1.2m`、`999` → `999`（不缩写）、`12000` → `12k`。
 *
 * 三条口径（都有理由）：
 * - **一位小数**：`3.2k` 足够表达量级，再多位是噪声；
 * - **去掉多余的 `.0`**：`12000` 显示 `12k` 而不是 `12.0k`（这是"数字看着对不对"最容易起疑的地方）；
 * - **四舍五入到一位后进位要重新判断**：`999_950` 四舍五入成 `1000.0k` 很怪，
 *   直接升级成 `1m`（所以先按 1000 进制选好单位，再格式化）。
 *
 * `null` / `undefined` / 非数字 → `null`，由调用方决定显示什么（我们显示"—"，**不编造 0**）。
 */
export const compactNumber = (value: unknown): string | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const abs = Math.abs(value)
  if (abs < 1000) return String(value)

  const units: Array<{ limit: number; suffix: string }> = [
    { limit: 1_000_000_000, suffix: 'b' },
    { limit: 1_000_000, suffix: 'm' },
    { limit: 1000, suffix: 'k' },
  ]
  let index = units.findIndex((item) => abs >= item.limit)
  if (index < 0) index = units.length - 1

  // 四舍五入到一位小数后可能刚好到 1000（如 999_960 → `1000.0k`）→ 升级到更大单位
  let scaled = value / units[index]!.limit
  if (Math.abs(Number(scaled.toFixed(1))) >= 1000 && index > 0) {
    index -= 1
    scaled = value / units[index]!.limit
  }
  // 保留一位小数；`12.0` 这种把 `.0` 去掉
  const text = scaled.toFixed(1).replace(/\.0$/, '')
  return `${text}${units[index]!.suffix}`
}

/** 精确数字（千分位）：`3179` → `3,179`；拿不到值时返回 `null` */
export const exactNumberText = (value: unknown): string | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value.toLocaleString('en-US')
}

/**
 * token 字段 → 显示文本：数字走 {@link compactNumber}，缺失显示 `—`。
 *
 * `null` 与 `0` 是两件事（provider 没上报 vs 真的是 0），所以缺失**不能**显示 0。
 */
export const tokenText = (value: unknown): string => compactNumber(value) ?? '—'

/** 时长：`1234` → `1.2s`；`820` → `820ms`；缺失 → `—` */
export const durationText = (value: unknown): string => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return value >= 1000 ? `${(value / 1000).toFixed(1).replace(/\.0$/, '')}s` : `${value}ms`
}

/**
 * **缓存命中率**：命中 token ÷ 输入 token，取整百分比（`2944 / 4520` → `65%`）。
 *
 * 口径（为什么分母是输入）：各家（DeepSeek 实测）的 `inputTokens` **本身包含命中数**
 * （第 2 轮输入 5,991、命中 4,352、未命中 1,639），所以"命中 / 输入"才是命中率，
 * 不需要再算一个"计价输入"。用比例而不是绝对值，是因为这一列的用处是判断
 * "提示词前缀有没有被复用"——绝对值还得拿输入去除，比例一眼可读。
 *
 * 拿不到命中数 / 输入为 0 / 非数字 → `null`（调用方整段不显示，**不编造 0%**：
 * "没上报"与"命中 0%"是两件事）。
 */
export const cacheHitPercentText = (usage: Record<string, unknown> | null): string | null => {
  if (!usage) return null
  const hit = usage.cacheReadTokens
  const input = usage.inputTokens
  if (typeof hit !== 'number' || typeof input !== 'number') return null
  if (!Number.isFinite(hit) || !Number.isFinite(input) || input <= 0) return null
  return `${Math.round((hit / input) * 100)}%`
}

/**
 * 输入框右下角的统计文案：`N 轮 M 步，输入 X，输出 Y，缓存命中 Z%`。
 *
 * 分工：**文案的拼装口径在这里（纯函数、可单测）**，组件只负责包一层 `<span title=…>`。
 *
 * 两条口径：
 * - **逗号分隔**，与用户给的说法一致（`，` 全角；数字内部不带分隔符，读起来是"三段"）；
 * - **缺失的项整段消失**（provider 没上报就不是 0）：没有缓存命中时，连"缓存命中"四个字都不出现。
 */
export const usageLineText = (
  usage: Record<string, unknown> | null,
  turn: number,
): string | null => {
  if (!usage) return null
  const steps = typeof usage.stepCount === 'number' ? usage.stepCount : 0
  const hitPercent = cacheHitPercentText(usage)
  const segments = [
    `${turn} 轮 ${steps} 步`,
    `输入 ${tokenText(usage.inputTokens)}，输出 ${tokenText(usage.outputTokens)}`,
    hitPercent ? `缓存命中 ${hitPercent}` : '',
  ]
  return segments.filter(Boolean).join('，')
}

/**
 * 统计的**悬停详情**（精确值，千分位）：`N 轮 · M 步 · 输入 1,650 · … · 缓存命中 65%（2,944）· 耗时 1.2s`。
 *
 * 为什么与上面那行分开：行内要短（一眼看量级与命中率），悬停要全（对账时能拿到每一位数字，
 * 缓存那一项**带上绝对 token 数**，因为它就是百分比算不出来的原始信息）。
 */
export const usageLineTitle = (usage: Record<string, unknown> | null, turn: number): string => {
  if (!usage) return ''
  const steps = typeof usage.stepCount === 'number' ? usage.stepCount : 0
  const hitPercent = cacheHitPercentText(usage)
  const segments: Array<string | null> = [
    `${turn} 轮 · ${steps} 步`,
    `输入 ${exactNumberText(usage.inputTokens) ?? '—'}`,
    `输出 ${exactNumberText(usage.outputTokens) ?? '—'}`,
    `合计 ${exactNumberText(usage.totalTokens) ?? '—'}`,
    hitPercent ? `缓存命中 ${hitPercent}（${exactNumberText(usage.cacheReadTokens)}）` : null,
    typeof usage.reasoningTokens === 'number'
      ? `推理 ${exactNumberText(usage.reasoningTokens)}`
      : null,
    `耗时 ${durationText(usage.durationMs)}`,
  ]
  // 先 trim 再过滤：拼装类代码最容易出"看不见的尾随空格"，那种问题光看测试期望值几乎发现不了
  // （这一处就为此多花了几轮），用机制兜住，别靠人眼。
  return segments
    .filter((segment): segment is string => Boolean(segment?.trim()))
    .map((segment) => segment.trim())
    .join(' · ')
}

/**
 * **相对时间**：`刚刚` / `N 秒前` / `N 分钟前` / `N 小时前` / `N 天前`（超过一周回落到日期）。
 *
 * 为什么会话列表要相对时间：列表是"最近聊过什么"的入口，用户扫的是**新旧**而不是具体时刻 ——
 * `17:23` 得先在脑子里算"现在几点"，`3 分钟前` 一眼就知道该点哪个。
 * 超过一周之后相对值反而失真（"9 天前"不如 `9月22日` 有用），所以设了回落阈值。
 *
 * 三条口径：
 * - **`now` 可注入**：纯函数，测试不用冻结时钟；
 * - **未来时间**（时钟漂移 / 服务端与浏览器不同步）按 `刚刚` 处理，不显示"负 3 分钟前"；
 * - 认不出 / 缺失 → `null`，由调用方决定显示什么（**不编造时间**）。
 */
export const relativeTimeText = (
  value: string | Date | null | undefined,
  now: number = Date.now(),
): string | null => {
  if (value === null || value === undefined) return null
  const time = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(time)) return null

  const diffMs = now - time
  if (diffMs < 60_000) return '刚刚'

  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return `${minutes} 分钟前`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`

  // 超过一周：给日期（同年省略年份，跨年才带上，避免每个列表项都拖一串数字）
  const date = new Date(time)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return sameYear
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}
