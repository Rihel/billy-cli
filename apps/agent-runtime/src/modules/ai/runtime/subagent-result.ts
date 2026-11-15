/**
 * 子助手结果的**工作区落点约定**（路径即引用）。
 *
 * 为什么不把全文塞回父上下文（2026-11-15 定）：
 * - 三份调研报告合起来几万字，全量进父模型既撑窗口又贵（实测一次会话 331 万 token）；
 * - 落成 Markdown 后，`read-file` 能按行分页读，用户也能在文件树里直接看到；
 * - `wait-sub-agent` / `sub-agent-list` 只返回 `path + summary`，需要全文再读。
 *
 * 路径是**约定**（不是扫描出来的）：子助手收尾时按同一函数写，工具侧按同一函数拼，
 * 所以即使落盘失败，工具也能给出"应该在哪"的路径，模型读不到再回退子会话。
 */

/** 文件名里最多保留多少个字符（中文名也按字符数算） */
const MAX_NAME_CHARS = 40

/** 子助手名 → 文件名安全片段：保留中英文 / 数字，其余折成 `-` */
export const subAgentFileSlug = (name: string): string => {
  const slug = name
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME_CHARS)
  return slug || 'subagent'
}

/** 子助手结果在工作区里的固定相对路径（根会话工作区） */
export const subAgentResultPath = (name: string, subRunId: string): string =>
  `subagents/${subAgentFileSlug(name)}-${subRunId}.md`
