'use client'

import {
  getToolName,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
  type UIMessage,
} from 'ai'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  toastError,
  toastSuccess,
} from '@repo/ui'
import { MessageAction } from '@repo/ui/components/ai-elements/message.tsx'
import { CopyIcon } from 'lucide-react'
import { copyText } from '@/lib/clipboard'
import { collectMessagePlan, type PlanTask } from './plan-panel'

/**
 * 消息导出：把**一条消息**摊成可粘贴的文本（两种形态，内容相同、格式不同）。
 *
 * - **Markdown**：保留原有的 Markdown 结构（正文原样），思考 / 工具 / 子助手 / 计划
 *   用引用块、代码块表达 —— 粘到文档或另一个 AI 对话框里，层次还在；
 * - **纯文本**：剥掉 Markdown 标记（`**粗体**` → `粗体`、链接只留文字），
 *   粘进记事本 / 工单 / 纯文本输入框时不会带着一堆符号。
 *
 * 两条硬口径：
 * 1. **顺序即所见**：按 `message.parts` 的原始顺序导出，和界面上从上到下看到的一致
 *    （工具卡就地铺开，不是攒到结尾）；
 * 2. **只导有内容的东西**：协议管道（`step-start` / `data-run` / 用量 / 自动命名 / 增量块）
 *    不进导出；被计划卡片吸收掉的计划类工具调用也不重复导出（与 `ChatMessage` 的渲染口径完全一致）。
 */

type CopyBlock =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'plan'; tasks: readonly PlanTask[] }
  | {
      kind: 'tool'
      toolName: string
      state: string
      input?: unknown
      output?: unknown
      errorText?: string
    }
  | { kind: 'subagent'; name: string; task?: string; status?: string; result?: string; error?: string }

/** 工具状态的人话（导出里也要看得懂"这次调用到底成了没"） */
const TOOL_STATE_LABEL: Record<string, string> = {
  'input-streaming': '准备入参',
  'input-available': '执行中',
  'output-available': '已完成',
  'output-error': '出错',
}

/** 计划任务状态 → 导出用的标记 */
const PLAN_LABEL: Record<PlanTask['status'], string> = {
  pending: '待办',
  in_progress: '进行中',
  done: '已完成',
  blocked: '受阻',
}

/** 任意值 → 便于阅读的文本（工具入参出参可能是任何东西，不能假设是对象） */
const toReadable = (value: unknown): string => {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** 逐行加引用前缀（Markdown 引用块里换行必须每行都带 `>`，否则后一行会跑出引用） */
const quote = (text: string): string =>
  text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n')

/**
 * 按 `message.parts` 顺序归并出导出块。
 *
 * 计划两块合一：`plan-*` 工具调用与 `data-plan` 事件都归到末尾那块计划上
 * （与界面一致：一条消息只显示一份当前计划）。
 */
const blocksOf = (message: UIMessage): CopyBlock[] => {
  const plan = collectMessagePlan(message.parts)
  const consumed = new Set(plan?.consumed ?? [])
  const blocks: CopyBlock[] = []

  for (const [index, part] of message.parts.entries()) {
    if (isTextUIPart(part)) {
      if (part.text.trim()) blocks.push({ kind: 'text', text: part.text })
      continue
    }
    if (isReasoningUIPart(part)) {
      if (part.text.trim()) blocks.push({ kind: 'reasoning', text: part.text })
      continue
    }
    if (isToolUIPart(part)) {
      if (consumed.has(index)) continue
      blocks.push({
        kind: 'tool',
        toolName: getToolName(part),
        state: part.state,
        input: part.input,
        output: 'output' in part ? part.output : undefined,
        errorText: 'errorText' in part ? part.errorText : undefined,
      })
      continue
    }
    if (part.type === 'data-sub-agent') {
      const data = part.data as Record<string, unknown>
      blocks.push({
        kind: 'subagent',
        name: typeof data.name === 'string' ? data.name : '子助手',
        task: typeof data.task === 'string' ? data.task : undefined,
        status: typeof data.status === 'string' ? data.status : undefined,
        result: typeof data.result === 'string' ? data.result : undefined,
        error: typeof data.error === 'string' ? data.error : undefined,
      })
    }
  }

  if (plan) blocks.push({ kind: 'plan', tasks: plan.current.plan.tasks })
  return blocks
}

/**
 * 剥掉 Markdown 标记（**不是**完整的 Markdown 解析器，只处理对话里真正会出现的那几类）。
 *
 * 顺序有讲究：代码块先整体摘出来（里面的 `*` / `#` 是内容，不是标记），
 * 再处理行内标记，最后才是行首的块级标记。
 */
export const markdownToPlainText = (markdown: string): string =>
  markdown
    // 围栏代码块：只留代码本身（语言标记去掉、末尾补一个换行）
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (_match, code: string) => `${code.replace(/\s+$/, '')}\n`)
    // 行内代码 / 粗体 / 斜体 / 删除线 / 高亮
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/==([^=\n]+)==/g, '$1')
    // 图片（留 alt）与链接（留文字）
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // 块级：标题 / 引用 / 列表 / 分隔线 / 表格分隔行
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]{0,3}[-*+][ \t]+/gm, '')
    .replace(/^[ \t]{0,3}\d+\.[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm, '')
    // 表格：分隔行整行删掉，剩下的竖线换成两个空格（保住列间距）
    .replace(/^[ \t]*\|?[ \t:|-]*-[ \t:|-]*\|[ \t:|-]*$/gm, '')
    .replace(/^[ \t]*\|/gm, '')
    .replace(/\|[ \t]*$/gm, '')
    .replace(/[ \t]*\|[ \t]*/g, '  ')
    // 多余空行收一收
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/** 一条消息 → Markdown（保留结构，粘到支持 Markdown 的地方层次还在） */
export const messageToMarkdown = (message: UIMessage): string => {
  const sections: string[] = []
  for (const block of blocksOf(message)) {
    if (block.kind === 'text') {
      sections.push(block.text.trim())
      continue
    }
    if (block.kind === 'reasoning') {
      sections.push(`**思考过程**\n\n${quote(block.text.trim())}`)
      continue
    }
    if (block.kind === 'subagent') {
      const lines = [`**子助手 · ${block.name}**${block.status ? `（${block.status}）` : ''}`]
      if (block.task) lines.push(`\n任务：${block.task}`)
      if (block.result) lines.push(`\n结论：\n\n${quote(block.result.trim())}`)
      if (block.error) lines.push(`\n错误：${block.error}`)
      sections.push(lines.join('\n'))
      continue
    }
    if (block.kind === 'plan') {
      const lines = block.tasks.map((task) =>
        task.status === 'done' ? `- [x] ${task.title}` : `- [ ] ${task.title}（${PLAN_LABEL[task.status]}）`,
      )
      sections.push(`**当前计划**\n\n${lines.join('\n')}`)
      continue
    }
    const lines = [`**工具调用 · \`${block.toolName}\`**（${TOOL_STATE_LABEL[block.state] ?? block.state}）`]
    const input = toReadable(block.input)
    if (input) lines.push(`\n入参：\n\n\`\`\`json\n${input}\n\`\`\``)
    const output = toReadable(block.output)
    if (output) lines.push(`\n出参：\n\n\`\`\`json\n${output}\n\`\`\``)
    if (block.errorText) lines.push(`\n错误：\n\n\`\`\`\n${block.errorText}\n\`\`\``)
    sections.push(lines.join('\n'))
  }
  return sections.join('\n\n---\n\n')
}

/** 一条消息 → 纯文本（同样的内容，剥掉 Markdown 标记） */
export const messageToPlainText = (message: UIMessage): string => {
  const sections: string[] = []
  for (const block of blocksOf(message)) {
    if (block.kind === 'text') {
      sections.push(markdownToPlainText(block.text))
      continue
    }
    if (block.kind === 'reasoning') {
      sections.push(`【思考过程】\n${markdownToPlainText(block.text)}`)
      continue
    }
    if (block.kind === 'subagent') {
      const lines = [`【子助手 · ${block.name}】${block.status ? `（${block.status}）` : ''}`]
      if (block.task) lines.push(`任务：${block.task}`)
      if (block.result) lines.push(`结论：\n${markdownToPlainText(block.result)}`)
      if (block.error) lines.push(`错误：${block.error}`)
      sections.push(lines.join('\n'))
      continue
    }
    if (block.kind === 'plan') {
      const lines = block.tasks.map((task) => `- [${task.status === 'done' ? 'x' : ' '}] ${task.title}`)
      sections.push(`【当前计划】\n${lines.join('\n')}`)
      continue
    }
    const lines = [
      `【工具调用 · ${block.toolName}】${TOOL_STATE_LABEL[block.state] ?? block.state}`,
    ]
    const input = toReadable(block.input)
    if (input) lines.push(`入参：\n${input}`)
    const output = toReadable(block.output)
    if (output) lines.push(`出参：\n${output}`)
    if (block.errorText) lines.push(`错误：\n${block.errorText}`)
    sections.push(lines.join('\n'))
  }
  return sections.join('\n\n')
}

/**
 * 消息右下角（用户消息在左下侧）的复制入口：一个图标按钮 + 两种格式的菜单。
 *
 * 放在 `Message` 里、`MessageContent` 外面：气泡的圆角背景只包内容，
 * 复制按钮是"对这条消息的操作"，不该跟着一起变成气泡的一部分。
 * `group-hover` 才显形（鼠标划过消息时出现），键盘 Tab 聚焦也会显形（`focus-within`）。
 */
export function MessageCopyMenu({ message }: { message: UIMessage }) {
  if (message.parts.length === 0) return null

  const copy = async (format: 'markdown' | 'text') => {
    const content = format === 'markdown' ? messageToMarkdown(message) : messageToPlainText(message)
    if (!content.trim()) {
      toastError('这条消息没有可复制的内容')
      return
    }
    try {
      await copyText(content)
      toastSuccess(format === 'markdown' ? '已复制为 Markdown' : '已复制为纯文本')
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <MessageAction tooltip="复制这条消息" label="复制这条消息" aria-label="复制这条消息">
            <CopyIcon className="size-3.5" />
          </MessageAction>
        }
      />
      <DropdownMenuContent align={message.role === 'user' ? 'end' : 'start'} className="w-40">
        <DropdownMenuItem onClick={() => void copy('markdown')}>复制为 Markdown</DropdownMenuItem>
        <DropdownMenuItem onClick={() => void copy('text')}>复制为纯文本</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
