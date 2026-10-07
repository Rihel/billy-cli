import type { Metadata } from 'next'
import { Markdown } from '@repo/ui'

export const metadata: Metadata = {
  title: '完整文档 - Markdown 演示',
}

const content = `# Billy CLI 前端开发指南

> 本文是一篇模拟的完整开发文档，用于验证 Markdown 组件在长文场景下
> 混合标题、列表、表格、代码块、引用与任务列表时的整体排版效果。

## 环境准备

开始之前，请确保本机已安装以下工具：

1. Node.js 22 及以上
2. pnpm 11
3. PostgreSQL 16 与 Redis 7

## 快速开始

\`\`\`bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm dev:pkgs
pnpm dev:server
\`\`\`

## 分层架构

工程采用依赖方向不可逆的分层设计，各包职责如下：

| 包 | 职责 | 依赖 |
| --- | --- | --- |
| \`@repo/shared\` | Zod 数据结构、字典、响应格式 | 无 |
| \`@repo/kits\` | 后端通用能力封装 | shared |
| \`@repo/ui\` | 前端组件库 | shared |
| \`@repo/sdk\` | 全类型化 API 客户端 | http-client |
| \`apps/server\` | NestJS 控制器与业务模块 | kits / shared |

### 依赖方向

- \`shared\` 不依赖任何业务包
- \`kits\` 不 import \`apps/*\`
- 业务模块与路由在 \`apps/server\` 内物理分层

## 开发清单

- [x] 安装依赖并启动基础设施
- [x] 生成数据库迁移
- [ ] 实现业务模块（商品 / 订单 / 文章）
- [ ] 接入前端列表页与表单页
- [ ] 编写单元测试并跑通 CI

## 常见问题

### 端口被占用

> 9989 被占用时，先检查是否有残留的 server 进程：
> \`lsof -i :9989\`，确认后 \`kill\` 对应进程再重启。

### 迁移报错

**原因**：实体与迁移文件不同步。

**处理**：重新生成迁移并执行：

\`\`\`bash
pnpm db:gen
pnpm db:migrate
\`\`\`

### 前端连不上接口

1. 确认 \`NEXT_PUBLIC_SERVER_URL\` 指向正确地址
2. 确认 server 已启动且数据库可用
3. ~~检查旧的鉴权配置~~（已废弃，改为自动发现）

## 结语

组件在长文档场景下的表现：标题层级清晰、表格可横向滚动、代码块高亮可读、
任务列表状态直观，引用与分隔线在长文中起到良好的节奏作用。
`

export default function MarkdownArticlePage() {
  return (
    <article>
      <Markdown content={content} />
    </article>
  )
}
