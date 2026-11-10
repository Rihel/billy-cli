/**
 * 技能 Markdown 的小工具（纯函数，便于单测）。
 */

/**
 * 去掉 `SKILL.md` 的 YAML frontmatter。
 *
 * 为什么需要：`/ai-skill/file/read` 返回的是**整份文件**（含 frontmatter），
 * 而块编辑器只该看正文。直接把 `---` 开头的文本灌进 BlockNote，会被 Markdown 解析成
 * setext 标题 —— 页面上就会出现 `name:` / `description:` 这样的"伪内容"。
 *
 * frontmatter 的编辑入口是画布顶部的标题 / 描述（以及"技能设置"），保存时由服务端重新拼回去。
 */
export const stripFrontmatter = (markdown: string): string => {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown)
  return match ? markdown.slice(match[0].length) : markdown
}
