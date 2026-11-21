'use client'

import { Button } from '#components/ui/button.tsx'
import { cn } from '#lib/utils.ts'
import type { UIMessage } from 'ai'
import { ArrowDownIcon, DownloadIcon } from 'lucide-react'
import type { ComponentProps } from 'react'
import { useCallback, useEffect, useRef } from 'react'
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom'

export type ConversationProps = ComponentProps<typeof StickToBottom>

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn('relative flex-1 overflow-y-hidden', className)}
    /**
     * 进入会话时**不要**"从顶部滑到底部"的动画。
     *
     * `use-stick-to-bottom` 的规则：内容**第一次**长高用 `initial`，之后的每一次长高用 `resize`。
     * 而历史是异步到的 —— 挂载时还是空列表，历史一到就是"第一次长高"，默认的
     * `initial="smooth"` 会在那一刻起一段弹簧动画，看起来就是"点进会话后页面自己往下滚"。
     * 首屏定位必须是瞬间的（一帧内到位，不让人看见过程）；流式输出仍交给 `resize="smooth"` 跟随。
     */
    initial="instant"
    resize="smooth"
    role="log"
    {...props}
  />
)

/**
 * 出现「用户自己发的新消息」时，强制回到底部。
 *
 * 为什么不能只靠 `resize` 跟随：一轮结束后输入区上方的 dock（任务卡 / 运行状态）高度会变，
 * `use-stick-to-bottom` 会把粘底状态判成"不在底部"；之后用户再发消息，内容长高也不会跟
 * （2026-11-21 反馈"发完新消息不滚"）。
 *
 * 触发值取**最后一条用户消息的 id**：历史加载完、用户发新消息都会变；
 * 流式增量不会变，所以不会在 AI 输出时抢视图。用户自己发消息是唯一"必须拉到底"的动作。
 */
export const ConversationAutoScroll = ({
  trigger,
  behavior = 'smooth',
}: {
  /** 触发值（一般传最后一条用户消息的 id）：变化时滚到底 */
  trigger: unknown
  behavior?: 'smooth' | 'instant'
}) => {
  const { scrollToBottom } = useStickToBottomContext()
  const last = useRef(trigger)

  useEffect(() => {
    if (trigger === last.current) return
    last.current = trigger
    // 库返回 Promise（平滑滚动被用户打断时会 resolve false），这里不关心结果
    void scrollToBottom(behavior)
  }, [trigger, behavior, scrollToBottom])

  return null
}

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>

export const ConversationContent = ({ className, ...props }: ConversationContentProps) => (
  <StickToBottom.Content className={cn('flex flex-col gap-8 p-4', className)} {...props} />
)

export type ConversationEmptyStateProps = ComponentProps<'div'> & {
  title?: string
  description?: string
  icon?: React.ReactNode
}

export const ConversationEmptyState = ({
  className,
  title = '还没有消息',
  description = '说点什么，这里就会显示你们的对话',
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      'flex size-full flex-col items-center justify-center gap-3 p-8 text-center',
      className,
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && <p className="text-muted-foreground text-sm">{description}</p>}
        </div>
      </>
    )}
  </div>
)

export type ConversationScrollButtonProps = ComponentProps<typeof Button>

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()

  const handleScrollToBottom = useCallback(() => {
    void scrollToBottom()
  }, [scrollToBottom])

  return (
    !isAtBottom && (
      <Button
        className={cn(
          'absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted',
          className,
        )}
        onClick={handleScrollToBottom}
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  )
}

const getMessageText = (message: UIMessage): string =>
  message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')

export type ConversationDownloadProps = Omit<ComponentProps<typeof Button>, 'onClick'> & {
  messages: UIMessage[]
  filename?: string
  formatMessage?: (message: UIMessage, index: number) => string
}

const defaultFormatMessage = (message: UIMessage): string => {
  const roleLabel = message.role.charAt(0).toUpperCase() + message.role.slice(1)
  return `**${roleLabel}:** ${getMessageText(message)}`
}

export const messagesToMarkdown = (
  messages: UIMessage[],
  formatMessage: (message: UIMessage, index: number) => string = defaultFormatMessage,
): string => messages.map((msg, i) => formatMessage(msg, i)).join('\n\n')

export const ConversationDownload = ({
  messages,
  filename = 'conversation.md',
  formatMessage = defaultFormatMessage,
  className,
  children,
  ...props
}: ConversationDownloadProps) => {
  const handleDownload = useCallback(() => {
    const markdown = messagesToMarkdown(messages, formatMessage)
    const blob = new Blob([markdown], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.append(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }, [messages, filename, formatMessage])

  return (
    <Button
      className={cn(
        'absolute top-4 right-4 rounded-full dark:bg-background dark:hover:bg-muted',
        className,
      )}
      onClick={handleDownload}
      size="icon"
      type="button"
      variant="outline"
      {...props}
    >
      {children ?? <DownloadIcon className="size-4" />}
    </Button>
  )
}
