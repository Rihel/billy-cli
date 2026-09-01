import type { Metadata } from 'next'
import { Markdown } from '@repo/ui'

export const metadata: Metadata = {
  title: '基础语法 - Markdown 演示',
}

const content = `# 基础语法演示

这是一段**普通段落**，用于验证段落间距与行高。文档渲染组件面向阅读场景，
行距、字号与留白都按正文排版做了适配，长段落阅读不费眼。

## 标题层级

标题从一级到六级，字号逐级递减，一级与二级标题带下划线分隔线：

### 三级标题

#### 四级标题

##### 五级标题

###### 六级标题

## 文本样式

- **加粗**用于强调关键信息
- *斜体*用于引用术语或书名
- ~~删除线~~表示已废弃的内容
- 行内代码 \`pnpm dev\` 用于标记命令或标识符
- 组合使用：**加粗中包含 *加粗斜体* 的效果**

## 列表

### 无序列表

- 第一项
- 第二项
  - 嵌套项 A
  - 嵌套项 B
- 第三项

### 有序列表

1. 安装依赖
2. 启动开发环境
   1. 先启动基础包监听
   2. 再启动目标应用
3. 打开浏览器验证

## 引用

> 代码评审是团队最重要的质量关口。
>
> 提交之前，先跑一遍类型检查与单元测试，再对照差异逐行审查。

## 分割线

分割线用于分隔内容区块，下面是一条水平线：

---

## 链接与图片

- 外部链接：[Next.js 官方文档](https://nextjs.org/docs)
- 图片（占位图，验证 \`img\` 元素样式）：

![示例图片](https://picsum.photos/seed/billy-markdown/1200/480)
`

export default function MarkdownBasicPage() {
  return (
    <article>
      <Markdown content={content} />
    </article>
  )
}
