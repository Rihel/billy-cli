import type { Metadata } from 'next'
import { Markdown } from '@repo/ui'

export const metadata: Metadata = {
  title: '代码高亮 - Markdown 演示',
}

const content = `# 代码高亮演示

代码块基于 \`rehype-highlight\`（highlight.js），支持常见编程语言，
token 颜色随明暗主题自动切换。本页验证多语言高亮、行内代码与无语言标注代码块的兜底样式。

## TypeScript

\`\`\`ts
interface User {
  id: string
  name: string
  active: boolean
  roles: Array<'admin' | 'member'>
}

const users: User[] = [
  { id: 'u_001', name: '张三', active: true, roles: ['admin'] },
  { id: 'u_002', name: '李四', active: false, roles: ['member'] },
]

const activeNames = users
  .filter((user) => user.active)
  .map((user) => user.name)
  .join(', ')
\`\`\`

## Bash

\`\`\`bash
pnpm install
pnpm dev:pkgs
pnpm dev:server
curl -X POST http://localhost:9989/api/health
\`\`\`

## JSON

\`\`\`json
{
  "name": "billy-cli",
  "packageManager": "pnpm@11.15.0",
  "scripts": {
    "dev:web": "pnpm --filter web run dev",
    "dev:admin": "pnpm --filter admin run dev"
  }
}
\`\`\`

## SQL

\`\`\`sql
SELECT u.name, count(t.id) AS todo_count
FROM users u
LEFT JOIN todos t ON t.user_id = u.id AND t.deleted_at IS NULL
WHERE u.active = true
GROUP BY u.id
ORDER BY todo_count DESC
LIMIT 10;
\`\`\`

## Python

\`\`\`python
from datetime import datetime


def format_timestamp(ts: datetime) -> str:
    """返回格式化后的时间字符串"""
    return ts.strftime("%Y-%m-%d %H:%M:%S")
\`\`\`

## 无语言标注的代码块

未标注语言的代码块走兜底样式（透明底、无行内代码样式干扰）：

\`\`\`
这是一段纯文本代码块
没有语言标注
验证 pre 内的兜底渲染
\`\`\`

## 行内代码

在正文中插入 \`pnpm db:gen\`、\`pnpm db:migrate\` 与 \`pnpm seed:admin\` 等命令，
验证行内代码与正文混排的样式。

## 混合场景

> 代码块与引用、列表组合时，各元素间距应保持协调：

- 先执行 \`pnpm db:gen\` 生成迁移文件
- 再执行 \`pnpm db:migrate\` 应用迁移
- 最后用 \`pnpm seed:admin\` 写入初始管理员
`

export default function MarkdownCodePage() {
  return (
    <article>
      <Markdown content={content} />
    </article>
  )
}
