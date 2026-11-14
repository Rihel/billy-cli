import { createHash } from 'node:crypto'

/**
 * **按行分页 + 本地缓存**（`web-fetch` / `web-request` 共用）。
 *
 * 为什么不用引擎那套按字节分页（`core/tools/paginate.ts`）：
 * - 那套是给"任意 JSON 出参"兜底的，**页是按字节切的** —— 网页正文按字节切，
 *   会切在句子中间，模型拿到半句话只能猜；
 * - 网页是**天然分行的**（标题、段落、列表项各占一行），按行切每页都是一个完整的语义块，
 *   而且"1000 行"是人能预期、模型能算的量；
 * - 字节分页只在给模型的那一份上做映射，取下一页要走 `read-tool-result`；
 *   网页内容我们希望**同一个工具再调一次**就能接着读（`ref` + `page`），路径更短。
 *
 * 两个硬约束（与引擎那套同源）：
 * 1. **确定性**：同一 `ref` + 同一 `page` 永远给同一段文字 —— 缓存里的正文不可变，
 *    分页边界在入缓存时就算好；
 * 2. **不切碎任何东西**：页边界永远落在换行符上，页与页拼起来逐字等于原文。
 *
 * 缓存是**进程内**的：一次抓取只发一次请求，翻页全在内存里切片。
 * 重启 / 过期后 `ref` 失效，工具会明确说"重新传 url 抓一次"，而不是静默给空。
 */

/** 一次抓取的完整结果（缓存的就是它：正文 + 分页边界 + 元信息） */
export interface CachedDoc {
  /** 缓存句柄（模型下一页要带回来的那个） */
  ref: string
  /** 模型请求的地址 */
  url: string
  /** 实际取到内容的地址（跟完重定向之后） */
  finalUrl: string
  status: number
  contentType: string
  /** 页面标题（`<title>`；非 HTML 为 null） */
  title: string | null
  /** 完整正文（HTML 已转 Markdown）—— 分页只从这里切 */
  text: string
  /** 全文多少字符（= text.length，模型据此判断"要不要全读"） */
  chars: number
  /** 实际读到的字节数（网络口径，与字符数不同：中文 1 字 3 字节） */
  bytes: number
  /** 全文多少行 */
  lines: number
  /** 一共多少页（≥ 1） */
  pages: number
  /** 一页多少行（入缓存时定死：改配置等于另开一份缓存） */
  pageLines: number
  /** 每一页的字符区间 `[from, to)`（入缓存时算一次，取页 O(1)） */
  bounds: ReadonlyArray<{ from: number; to: number }>
  /** 是否因为字节上限被截断 */
  truncated: boolean
  /** 抓取时间（TTL 判定 + 出参里告诉模型"这是什么时候的内容"） */
  fetchedAt: number
  /** 工具专属的元信息（状态行 / 响应头子集），翻页时原样带回 */
  extra: Record<string, unknown>
}

/** 按行切页：返回行数与每页的字符区间（**页边界只落在换行符上**） */
export const splitPages = (
  text: string,
  pageLines: number,
): { lines: number; bounds: ReadonlyArray<{ from: number; to: number }> } => {
  const perPage = Math.max(1, Math.floor(pageLines))
  const bounds: { from: number; to: number }[] = []
  let from = 0
  let lineInPage = 0
  let lines = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue
    lines += 1
    lineInPage += 1
    if (lineInPage === perPage) {
      bounds.push({ from, to: i }) // 页尾到换行前（不含那个换行）
      from = i + 1
      lineInPage = 0
    }
  }
  // 收尾那一页：正文不是以换行结束的，最后那半行也要算一行、也要成一页
  if (from < text.length) {
    if (text.charCodeAt(text.length - 1) !== 10) lines += 1
    bounds.push({ from, to: text.length })
  }
  if (!bounds.length) bounds.push({ from: 0, to: 0 }) // 空正文也算一页
  return { lines, bounds }
}

/** 缓存句柄：`sha1(请求特征)` 前 12 位。同一份请求 → 同一个 ref → 命中缓存，不重复发请求 */
export const makeRef = (...parts: ReadonlyArray<string | number | null | undefined>): string =>
  createHash('sha1')
    .update(parts.filter((p) => p !== null && p !== undefined).join('|'))
    .digest('hex')
    .slice(0, 12)

/**
 * 进程内 LRU + TTL 缓存。
 *
 * 容量两个维度都要管：条数（防止模型刷一堆不同 URL）与**总字符数**
 * （一条 2MB 的正文就够顶掉别人，只按条数计会让内存无上限）。
 */
export class WebCache {
  private readonly entries = new Map<string, CachedDoc>()

  constructor(
    private readonly maxEntries = 24,
    private readonly maxChars = 24 * 1024 * 1024,
  ) {}

  /** 取一份（过期即删，删完返回 null —— 让调用方明确"需要重新抓"） */
  get(ref: string, ttlMs: number): CachedDoc | null {
    const doc = this.entries.get(ref)
    if (!doc) return null
    if (Date.now() - doc.fetchedAt > ttlMs) {
      this.entries.delete(ref)
      return null
    }
    // 命中即置末位：Map 的迭代顺序就是 LRU 顺序
    this.entries.delete(ref)
    this.entries.set(ref, doc)
    return doc
  }

  /** 存一份（先删同 ref 的旧值，再按条数 / 总字符数淘汰最久没用的） */
  put(doc: CachedDoc): void {
    this.entries.delete(doc.ref)
    this.entries.set(doc.ref, doc)
    let chars = 0
    for (const entry of this.entries.values()) chars += entry.chars
    while (
      this.entries.size > this.maxEntries ||
      (chars > this.maxChars && this.entries.size > 1)
    ) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      const victim = this.entries.get(oldest.value)
      this.entries.delete(oldest.value)
      chars -= victim?.chars ?? 0
    }
  }

  /** 当前缓存了多少条（测试 / 排障用） */
  get size(): number {
    return this.entries.size
  }
}

/** 一页视图（不含页脚文案：文案由工具按自己的提示词拼） */
export interface PageView {
  page: number
  pages: number
  remaining: number
  isLast: boolean
  content: string
  /** 请求的页码超出范围时的说明（缺省 = 正常页码） */
  notice?: string
}

/**
 * 取第 `page` 页（从 1 开始）。
 *
 * 页码越界**不报错**：模型算错页码（比如缓存换了、页数变了）不该让整轮失败，
 * 夹到有效范围 + 给一句 `notice` 说明，比"invalid-input"更有用。
 */
export const pageOf = (doc: CachedDoc, page: number): PageView => {
  const wanted = Number.isFinite(page) ? Math.floor(page) : 1
  const current = Math.min(Math.max(1, wanted), doc.pages)
  const bound = doc.bounds[current - 1] ?? { from: 0, to: doc.text.length }
  const content = doc.text.slice(bound.from, bound.to)
  const remaining = doc.pages - current
  return {
    page: current,
    pages: doc.pages,
    remaining,
    isLast: remaining <= 0,
    content,
    ...(wanted !== current
      ? {
          notice: `你请求的是第 ${wanted} 页，但这份内容一共只有 ${doc.pages} 页，已给第 ${current} 页`,
        }
      : {}),
  }
}

/**
 * 页脚（每页末尾那一行，汇报"共几页 / 当前第几页 / 还剩几页"）。
 *
 * 单独成句、放在正文之后：模型读到最后一页时，"还有没有"这件事必须是**明确的**，
 * 而不是靠它自己数 `page.total`。数错了就会在"已经读完了"的时候反复取页。
 */
export const footerOf = (view: PageView, pageLines: number): string =>
  view.isLast
    ? `共 ${view.pages} 页，当前第 ${view.page} 页，最后一页`
    : `共 ${view.pages} 页，当前第 ${view.page} 页，还剩 ${view.remaining} 页（1 页 = ${pageLines} 行）`
