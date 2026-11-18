import dedent from 'dedent'
import { z } from 'zod'

export const ReadToolResultParams = z.object({
  handle: z.string().min(1).max(128).describe('上一页给出的取页句柄（`page.handle`，原样传回）'),
  page: z.number().int().positive().optional().describe('要取的页码（从 1 开始）；省略即取第 1 页'),
})

export const READ_TOOL_RESULT_TOOL = {
  key: 'read-tool-result',
  title: '读取工具结果的下一页',
  category: 'core',
  scope: 'all',
  executor: 'worker',
  version: 1,
  params: ReadToolResultParams,
  description: dedent`
    读取某个工具结果的**后续页**（结果太大时只给了你一页）。

    什么时候用：出参里有 \`page\` 与 \`handle\`，而你需要后面的内容。
    什么时候不用：第一页够用就别取 —— 每次取页都花 token。

    约束：取到的是**原文片段**（没有摘要），自己判断该看哪一页；
    同一个 \`handle\` 可以反复取（结果已入库），但每轮取页次数有上限。
  `,
} as const
