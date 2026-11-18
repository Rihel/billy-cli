import dedent from 'dedent'
import { z } from 'zod'

/** `web-search` 的参数（server 声明 / gateway manifest / worker 执行共用） */
export const WebSearchParams = z.object({
  query: z
    .string()
    .min(1)
    .max(128)
    .describe(
      '搜索词（1~128 字符）。支持 site: / -site: / "精确短语" / -词 / lang:zh,en / after:2025-01-01 / before:2026',
    ),
  count: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(8)
    .describe('返回多少条（1~20，默认 8）。条数只影响上下文大小，不影响计费（按请求次数计费）'),
  needContent: z
    .boolean()
    .default(false)
    .describe('是否顺带抓回网页正文（默认 false）。为 true 时每条正文会被截断，摘要不够判断时再用'),
  question: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe('用户的原始问题（可选）：原样传用户那句话，帮助搜索引擎理解意图'),
})

export const WEB_SEARCH_TOOL = {
  key: 'web-search',
  title: '搜索网页（先找来源，再读）',
  category: 'core',
  scope: 'all',
  executor: 'worker',
  version: 1,
  params: WebSearchParams,
  description: dedent`
    搜索网页：给关键词，返回按相关度排序的来源清单（标题 / 链接 / 摘要 / 发布时间 / 权威度）。

    用在：确实不知道答案在哪个网页上，或要多个来源交叉核对。

    \`score\` ≥ 1.5 为优质，\`authority\` ≥ 3 为极权威。
  `,
} as const
