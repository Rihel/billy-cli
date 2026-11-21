/**
 * Markdown 的小工具（纯函数，便于单测）。
 *
 * 这里管的是 **YAML frontmatter**：`---` 包裹的那段声明式元数据。
 * 直接把它交给 Markdown 渲染，`---` 会被当成 setext 标题的下划线，
 * 正文里就冒出 `name:` / `description:` 这样的"伪内容"（技能编辑器和文件预览都踩过）。
 *
 * 所以展示正文前一律先切掉 frontmatter；需要展示的字段（name / description）
 * 用 `splitFrontmatter` 单独取出来，由调用方决定放哪儿。
 */

/** `---` 包裹的 frontmatter 段（含首尾分隔行与尾随换行） */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/

/** 去掉 `---` 包裹的 YAML frontmatter，只留正文 */
export const stripFrontmatter = (markdown: string): string => {
  const match = FRONTMATTER.exec(markdown)
  return match ? markdown.slice(match[0].length) : markdown
}

/** YAML 块标量标记（`description: >-` 这种折行写法在 `SKILL.md` 里很常见） */
const BLOCK_SCALAR = new Set(['|', '|-', '|+', '>', '>-', '>+'])

const unquote = (value: string): string => {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/**
 * 只认**顶层标量**（`key: value` 与块标量），不解释嵌套对象 / 列表。
 *
 * 展示用途只要 name / description 这种短字段，为此引一个 YAML 解析器不划算；
 * 认不出的行直接跳过 —— 正文剥离由 `FRONTMATTER` 正则保证，不会因为解析不全而漏掉内容。
 */
const parseScalars = (yaml: string): Record<string, string> => {
  const lines = yaml.split(/\r?\n/)
  const meta: Record<string, string> = {}
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1] as string
    const raw = (match[2] ?? '').trim()
    // 空值说明是嵌套对象 / 列表的键（`tags:` 后面跟缩进子项），跳过：展示层不要这些
    if (raw === '') continue
    if (BLOCK_SCALAR.has(raw)) {
      // 块标量：吃掉后续缩进行（空行也算在内，直到遇到下一个顶层键）
      const collected: string[] = []
      while (index + 1 < lines.length) {
        const next = lines[index + 1] ?? ''
        if (next.trim() !== '' && !/^[ \t]/.test(next)) break
        collected.push(next.replace(/^[ \t]+/, ''))
        index += 1
      }
      while (collected.length > 0 && (collected.at(-1) ?? '').trim() === '') collected.pop()
      meta[key] = raw.startsWith('>')
        ? collected
            .map((item) => item.trim())
            .filter(Boolean)
            .join(' ')
        : collected.join('\n')
      continue
    }
    meta[key] = unquote(raw)
  }
  return meta
}

/**
 * 拆开 frontmatter 与正文。
 *
 * 没有 frontmatter 时 `meta` 为空对象、`body` 原样返回；
 * 有 frontmatter 但某个字段是嵌套结构时该字段缺失（不影响正文）。
 */
export const splitFrontmatter = (
  markdown: string,
): { meta: Record<string, string>; body: string } => {
  const match = FRONTMATTER.exec(markdown)
  if (!match) return { meta: {}, body: markdown }
  return { meta: parseScalars(match[1] ?? ''), body: markdown.slice(match[0].length) }
}
