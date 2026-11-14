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
 * **缓存命中率**：命中 token ÷ 输入 token（`2944 / 4520` → `65.1…`）。
 *
 * 口径（为什么分母是输入）：各家（DeepSeek 实测）的 `inputTokens` **本身包含命中数**
 * （第 2 轮输入 5,991、命中 4,352、未命中 1,639），所以"命中 / 输入"才是命中率，
 * 不需要再算一个"计价输入"。用比例而不是绝对值，是因为这一列的用处是判断
 * "提示词前缀有没有被复用"——绝对值还得拿输入去除，比例一眼可读。
 *
 * 返回**未取整**的比例：渲染层做数字动画时要从小数滚到小数（`Math.round` 放在显示层）。
 * 拿不到命中数 / 输入为 0 / 非数字 → `null`（调用方整段不显示，**不编造 0%**）。
 */
export const cacheHitPercentValue = (usage: Record<string, unknown> | null): number | null => {
  if (!usage) return null
  const hit = usage.cacheReadTokens
  const input = usage.inputTokens
  if (typeof hit !== 'number' || typeof input !== 'number') return null
  if (!Number.isFinite(hit) || !Number.isFinite(input) || input <= 0) return null
  return (hit / input) * 100
}

/** 缓存命中率的**显示文本**（取整百分比）；拿不到 → `null` */
export const cacheHitPercentText = (usage: Record<string, unknown> | null): string | null => {
  const value = cacheHitPercentValue(usage)
  return value === null ? null : `${Math.round(value)}%`
}

/**
 * 用量行的一段：纯文本，或一个**要滚动的数字**（渲染层据此做数字动画）。
 *
 * 为什么分段而不是直接拼一个字符串：右下角是"跑一步跳一次"的实时值，数字直接换很生硬；
 * 分段后每个数字各自补间，而**文案口径仍只有 `usageLineSegments` 这一处**（`usageLineText`
 * 由它拼出来），两种用法不会漂移。
 */
export type UsageSegment =
  | { kind: 'text'; text: string }
  | { kind: 'number'; value: number; format: (value: number) => string }

/** 一个 token 数字段：有数字才滚动；缺失就是文本 `—`（provider 没上报 ≠ 0） */
const tokenSegment = (value: unknown): UsageSegment =>
  typeof value === 'number' && Number.isFinite(value)
    ? { kind: 'number', value, format: tokenText }
    : { kind: 'text', text: tokenText(value) }

/**
 * 输入框右下角统计行的**分段**：`N 轮 M 步，输入 X，输出 Y，缓存命中 Z%`。
 *
 * 两条口径（与 `usageLineText` 完全一致，改一处就两处一起变）：
 * - **逗号分隔**，与用户给的说法一致（`，` 全角；数字内部不带分隔符，读起来是"三段"）；
 * - **缺失的项整段消失**（provider 没上报就不是 0）：没有缓存命中时，连"缓存命中"四个字都不出现。
 *
 * @param usage - 本轮用量（实时或收尾，两者同形）。
 * @param turn - 该会话第几轮。
 * @returns 分段数组；没有用量返回 `null`（调用方整行不渲染）。
 */
export const usageLineSegments = (
  usage: Record<string, unknown> | null,
  turn: number,
): UsageSegment[] | null => {
  if (!usage) return null
  const steps = typeof usage.stepCount === 'number' ? usage.stepCount : 0
  const hitPercent = cacheHitPercentValue(usage)
  const segments: UsageSegment[] = [
    { kind: 'text', text: `${turn} 轮 ` },
    { kind: 'number', value: steps, format: (value) => String(Math.round(value)) },
    { kind: 'text', text: ' 步，输入 ' },
    tokenSegment(usage.inputTokens),
    { kind: 'text', text: '，输出 ' },
    tokenSegment(usage.outputTokens),
  ]
  if (hitPercent !== null) {
    segments.push({ kind: 'text', text: '，缓存命中 ' })
    segments.push({ kind: 'number', value: hitPercent, format: (value) => `${Math.round(value)}%` })
  }
  return segments
}

/**
 * 输入框右下角的统计文案：`N 轮 M 步，输入 X，输出 Y，缓存命中 Z%`（纯文本，由分段拼成）。
 *
 * 分工：**文案的拼装口径在 `usageLineSegments`**（渲染层也用它做数字动画）；
 * 本函数只负责把分段接成一串，供测试与"不需要动画"的场合使用。
 */
export const usageLineText = (
  usage: Record<string, unknown> | null,
  turn: number,
): string | null => {
  const segments = usageLineSegments(usage, turn)
  if (!segments) return null
  return segments
    .map((segment) => (segment.kind === 'text' ? segment.text : segment.format(segment.value)))
    .join('')
}

/**
 * 统计的**明细段**（精确值，千分位，不含"轮 / 步"前缀）：
 * `输入 1,650 · 输出 218 · 合计 1,868 · 缓存命中 65%（2,944）· 推理 120 · 耗时 1.2s`。
 *
 * 为什么单拆：累计行与"本轮"那一段共用同一套字段口径，只有前缀不同 —— 各写一份必然漂移。
 */
const usageDetailSegments = (usage: Record<string, unknown>): string[] => {
  const hitPercent = cacheHitPercentText(usage)
  const segments: Array<string | null> = [
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
}

/**
 * 统计的**悬停详情**（精确值，千分位）：`N 轮 · M 步 · 输入 1,650 · … · 缓存命中 65%（2,944）· 耗时 1.2s`。
 *
 * 为什么与行内分开：行内要短（一眼看量级与命中率），悬停要全（对账时能拿到每一位数字，
 * 缓存那一项**带上绝对 token 数**，因为它就是百分比算不出来的原始信息）。
 */
export const usageLineTitle = (usage: Record<string, unknown> | null, turn: number): string => {
  if (!usage) return ''
  const steps = typeof usage.stepCount === 'number' ? usage.stepCount : 0
  return [`${turn} 轮`, `${steps} 步`, ...usageDetailSegments(usage)].join(' · ')
}

/**
 * 悬停里给的**两段**：行内是大盘（整个会话累计），本轮那笔单独一行。
 *
 * 为什么要给本轮：改成累计之后，"这一轮花了多少"在界面上就只剩悬停能看 ——
 * 排查"某一轮为什么贵"（比如调了 18 次工具）时它是唯一入口。
 *
 * @param usage - 会话累计（行内那份）。
 * @param turn - 这是第几轮。
 * @param current - 本轮用量；拿不到（第一步还没跑完 / 没上报）就不给这一段。
 * @returns 以 `\n` 分行的 title 文本（两个原生 tooltip 都支持换行）。
 */
export const usageTooltip = (
  usage: Record<string, unknown> | null,
  turn: number,
  current: Record<string, unknown> | null,
): string => {
  const cumulative = usageLineTitle(usage, turn)
  if (!current) return cumulative
  const currentLine = usageDetailSegments(current).join(' · ')
  return cumulative ? `累计：${cumulative}\n本轮：${currentLine}` : `本轮：${currentLine}`
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

/** 一次失败的对话请求（`onError` 能拿到的、对用户有意义的部分） */
export interface ChatErrorInfo {
  /** 业务错误码（3306 会话忙 / 3310 超时…）；不是业务错误时为 undefined */
  code?: number
  /** 给人看的一句话（服务端信封里的 message；拿不到就退回原始文本） */
  message: string
}

/**
 * 把 `useChat` 抛出的错误整理成"用户看得懂的一句话"。
 *
 * 为什么需要：服务端错误是 JSON 信封（`{"code":3306,"message":"…","requestId":"…"}`），
 * AI SDK 会把**整段 JSON** 当 `Error.message` 抛出来 —— 界面上就是截图里那串大括号。
 * 真正有用的是 `message` 字段；`code` 留给调用方做特殊处理（例如 3306 提示"上一轮还在跑"）。
 *
 * 解析失败（网络错误 / 网关返回 HTML / 空响应）**原样返回**，不吞掉线索：
 * 排障时"原始文本"往往比一句笼统的"请求失败"更有用。
 */
export const parseChatError = (error: unknown): ChatErrorInfo => {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const text = raw.trim()
  if (!text) return { message: '请求失败（服务端没有返回原因）' }

  const tryParse = (value: string): ChatErrorInfo | null => {
    try {
      const parsed = JSON.parse(value) as { code?: unknown; message?: unknown }
      if (!parsed || typeof parsed !== 'object') return null
      const code = typeof parsed.code === 'number' ? parsed.code : Number(parsed.code)
      const message = typeof parsed.message === 'string' ? parsed.message.trim() : ''
      if (!Number.isFinite(code) && !message) return null
      return {
        ...(Number.isFinite(code) ? { code } : {}),
        message: message || text,
      }
    } catch {
      return null
    }
  }

  // ① 整个响应体就是 JSON（服务端异常过滤器就是这么回的）
  const direct = tryParse(text)
  if (direct) return direct

  // ② 网关 / 代理有时会包一层前缀（`HTTP 409: {...}`）：取第一对花括号再试一次
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const embedded = tryParse(text.slice(start, end + 1))
    if (embedded) return embedded
  }

  return { message: text }
}
