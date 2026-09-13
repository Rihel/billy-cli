import type { Metadata } from 'next'
import { Markdown } from '@repo/ui'

export const metadata: Metadata = {
  title: 'GFM 扩展 - Markdown 演示',
}

const content = `# GFM 扩展演示

GitHub Flavored Markdown 由 \`remark-gfm\` 提供，本页验证表格、任务列表、
删除线与自动链接的渲染效果。

## 表格

| 命令 | 用途 | 端口 |
| --- | --- | --- |
| \`pnpm dev:pkgs\` | 启动各包开发监听 | - |
| \`pnpm dev:server\` | 启动后端服务 | 9989 |
| \`pnpm dev:web\` | 启动 Web 前台 | 9840 |
| \`pnpm dev:admin\` | 启动 Admin 后台 | 9845 |

### 长表格（横向滚动）

表格列数较多时会自动启用横向滚动，避免挤压正文宽度：

| 服务 | 框架 | 语言 | 端口 | 职责 | 依赖 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| server | NestJS 12 | TypeScript | 9989 | HTTP 接口与 SSE 推流 | PostgreSQL / Redis | 业务模块组合根 |
| web | Next.js 16 | TypeScript | 9840 | C 端前台页面 | @repo/ui / sdk | Base UI + shadcn |
| admin | Next.js 16 | TypeScript | 9845 | 管理后台页面 | @repo/ui / sdk | TanStack 技术栈 |
| sdk | - | TypeScript | - | 全类型化 API 客户端 | http-client | 前端与脚本共用 |
| kits | - | TypeScript | - | 后端通用能力封装 | shared | 无业务实体 |

### 表格对齐

| 左对齐 | 居中 | 右对齐 |
| :--- | :---: | ---: |
| 左 | 中 | 右 |
| 一 | 二 | 三 |

## 任务列表

- [x] 安装依赖
- [x] 启动数据库与 Redis
- [ ] 生成并执行数据库迁移
- [ ] 联调接口与前端页面

## 删除线

~~这个接口已废弃~~，请使用 \`/api/v2\` 下的新接口。

## 自动链接

直接书写 URL 会被识别为可点击链接，例如 https://nextjs.org/docs 与
https://ui.shadcn.com/docs。

## 混合场景

> **注意**：表格中的行内代码、任务列表的勾选状态与自动链接，在嵌套场景下
> 应保持各自的样式一致。
`

export default function MarkdownGfmPage() {
  return (
    <article>
      <Markdown content={content} />
    </article>
  )
}
