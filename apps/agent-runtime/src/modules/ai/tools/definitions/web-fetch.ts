import dedent from 'dedent'
import { z } from 'zod'

/** `web-fetch` 的参数（server 声明与 gateway manifest 共用这一份） */
export const WebFetchParams = z.object({
  url: z
    .string()
    .min(1)
    .max(2048)
    .optional()
    .describe(
      '要抓的网页地址（http / https，要带协议）。**首次抓取必填**；只为了读下一页时可以省略，只传 ref',
    ),
  ref: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      '上一次抓取返回的缓存句柄。**读后续页时传它**：服务端从缓存切片，不会重新发起请求。过期或服务重启后失效',
    ),
  page: z
    .number()
    .int()
    .positive()
    .default(1)
    .describe(
      '要第几页（从 1 开始，1 页 = 1000 行）。默认第 1 页；每页结尾的页脚写着总页数与还剩几页',
    ),
})

export const WEB_FETCH_TOOL = {
  key: 'web-fetch',
  title: '抓取网页（转 Markdown，按页读）',
  category: 'core',
  scope: 'all',
  executor: 'worker',
  version: 1,
  params: WebFetchParams,
  description: dedent`
    抓取一个网页，HTML 转成 Markdown 后按页返回。

    用在：答案在某个**网页**上（文档 / 公告 / 文章），但你手上没有、或可能过时。
    不用：要调 JSON 接口、要 POST → \`web-request\`；登录 / 强反爬站点抓不到，别反复试。

    读法：\`document\` 是全文规模（字符/行/页），\`content\` 是本页，页脚写"共几页 / 第几页 / 还剩几页"。
    续页用 \`ref\` + \`page\`（参数说明见下）；\`via\` 非空 = 正文被反爬拦了，走的是官方摘要接口（**是摘要，不是全文**）。
  `,
} as const
