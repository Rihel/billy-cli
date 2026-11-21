'use client'

import { Button } from '#components/ui/button.tsx'
import { ButtonGroup, ButtonGroupText } from '#components/ui/button-group.tsx'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '#components/ui/tooltip.tsx'
import { cn } from '#lib/utils.ts'
import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'
import { math } from '@streamdown/math'
import { mermaid } from '@streamdown/mermaid'
import type { UIMessage } from 'ai'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import type { ComponentProps, HTMLAttributes, ReactElement } from 'react'
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import { Streamdown } from 'streamdown'
import { cloneElement, isValidElement, type ComponentType, type ReactNode } from 'react'
import { CodeFence, PlainPre } from './code-fence.tsx'
import { markdownFenceRenderers, RENDERED_FENCE_LANGUAGES } from './markdown-fences/renderers.tsx'

import 'katex/dist/katex.min.css'

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage['role']
}

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      'group flex w-full max-w-[95%] flex-col gap-2',
      from === 'user' ? 'is-user ml-auto justify-end' : 'is-assistant',
      className,
    )}
    {...props}
  />
)

export type MessageContentProps = HTMLAttributes<HTMLDivElement>

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      'is-user:dark flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm',
      'group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground',
      'group-[.is-assistant]:text-foreground',
      className,
    )}
    {...props}
  >
    {children}
  </div>
)

export type MessageActionsProps = ComponentProps<'div'>

export const MessageActions = ({ className, children, ...props }: MessageActionsProps) => (
  <div className={cn('flex items-center gap-1', className)} {...props}>
    {children}
  </div>
)

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string
  label?: string
}

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = 'ghost',
  size = 'icon-sm',
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  )

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger render={button} />
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return button
}

interface MessageBranchContextType {
  currentBranch: number
  totalBranches: number
  goToPrevious: () => void
  goToNext: () => void
  branches: ReactElement[]
  setBranches: (branches: ReactElement[]) => void
}

const MessageBranchContext = createContext<MessageBranchContextType | null>(null)

const useMessageBranch = () => {
  const context = useContext(MessageBranchContext)

  if (!context) {
    throw new Error('MessageBranch components must be used within MessageBranch')
  }

  return context
}

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number
  onBranchChange?: (branchIndex: number) => void
}

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch)
  const [branches, setBranches] = useState<ReactElement[]>([])

  const handleBranchChange = useCallback(
    (newBranch: number) => {
      setCurrentBranch(newBranch)
      onBranchChange?.(newBranch)
    },
    [onBranchChange],
  )

  const goToPrevious = useCallback(() => {
    const newBranch = currentBranch > 0 ? currentBranch - 1 : branches.length - 1
    handleBranchChange(newBranch)
  }, [currentBranch, branches.length, handleBranchChange])

  const goToNext = useCallback(() => {
    const newBranch = currentBranch < branches.length - 1 ? currentBranch + 1 : 0
    handleBranchChange(newBranch)
  }, [currentBranch, branches.length, handleBranchChange])

  const contextValue = useMemo<MessageBranchContextType>(
    () => ({
      branches,
      currentBranch,
      goToNext,
      goToPrevious,
      setBranches,
      totalBranches: branches.length,
    }),
    [branches, currentBranch, goToNext, goToPrevious],
  )

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div className={cn('grid w-full gap-2 [&>div]:pb-0', className)} {...props} />
    </MessageBranchContext.Provider>
  )
}

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>

export const MessageBranchContent = ({ children, ...props }: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch()
  const childrenArray = useMemo(() => (Array.isArray(children) ? children : [children]), [children])

  // Use useEffect to update branches when they change
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray)
    }
  }, [childrenArray, branches, setBranches])

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        'grid gap-2 overflow-hidden [&>div]:pb-0',
        index === currentBranch ? 'block' : 'hidden',
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ))
}

export type MessageBranchSelectorProps = ComponentProps<typeof ButtonGroup>

export const MessageBranchSelector = ({ className, ...props }: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch()

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null
  }

  return (
    <ButtonGroup
      className={cn(
        '[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md',
        className,
      )}
      orientation="horizontal"
      {...props}
    />
  )
}

export type MessageBranchPreviousProps = ComponentProps<typeof Button>

export const MessageBranchPrevious = ({ children, ...props }: MessageBranchPreviousProps) => {
  const { goToPrevious, totalBranches } = useMessageBranch()

  return (
    <Button
      aria-label="上一分支"
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeftIcon size={14} />}
    </Button>
  )
}

export type MessageBranchNextProps = ComponentProps<typeof Button>

export const MessageBranchNext = ({ children, ...props }: MessageBranchNextProps) => {
  const { goToNext, totalBranches } = useMessageBranch()

  return (
    <Button
      aria-label="下一分支"
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRightIcon size={14} />}
    </Button>
  )
}

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>

export const MessageBranchPage = ({ className, ...props }: MessageBranchPageProps) => {
  const { currentBranch, totalBranches } = useMessageBranch()

  return (
    <ButtonGroupText
      className={cn('border-none bg-transparent text-muted-foreground shadow-none', className)}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </ButtonGroupText>
  )
}

export type MessageResponseProps = ComponentProps<typeof Streamdown>

/**
 * 正文插件：CJK 断行 / Shiki 高亮 / KaTeX 公式 / mermaid 图，外加**富内容围栏**
 * （`xflow` / `html` / `gsap`，见 `./markdown-fences/renderers.tsx`）。
 *
 * `renderers` 按语言标识匹配：命中就交给对应组件渲染，没命中才落到普通代码块。
 * 围栏组件里的重依赖（React Flow）自己按需加载，不因为注册就在这里打进首屏包。
 */
const streamdownPlugins = { cjk, code, math, mermaid, renderers: markdownFenceRenderers }

/**
 * 普通代码围栏 → CodeMirror（语言高亮 + 右下角 hover 操作的复制/下载）；
 * 表格 → shadcn Table（无外层卡片、无 Streamdown 的复制/下载工具条）。
 * 自定义围栏（json / html / gsap / xflow）走 renderers，不经过这里。
 */
const streamdownComponents = {
  /**
   * 正文段落：**行高提到 1.75**（会话页的字号被 `.chat-type-scale` 压到 12px，
   * 继承下来的 1.5 行高对中文偏挤）。只给段落，不碰标题与代码块 —— 它们各自带行高。
   */
  p: ({ children }: { children?: ReactNode }) => <p className="leading-[1.75]">{children}</p>,
  /**
   * 链接：正文色 + 品牌淡下划线（不再用浏览器默认的紧贴下划线，也不把整段文字染成品牌色）；
   * 悬停时文字与下划线一起转品牌色，点开走新窗口（内链仍留在当前页）。
   */
  a: ({ href, children }: { href?: string; children?: ReactNode }) => {
    const external = typeof href === 'string' && /^https?:\/\//i.test(href)
    return (
      <a
        href={href}
        className="break-words text-foreground underline decoration-brand/40 underline-offset-[3px] transition-colors hover:text-brand hover:decoration-brand"
        {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
      >
        {children}
      </a>
    )
  },
  pre: ({ children }: { children?: ReactNode }) => {
    const child = Array.isArray(children) ? children[0] : children
    if (isValidElement(child)) {
      const props = child.props as { className?: string; children?: ReactNode }
      const language = /language-([\w+-]+)/.exec(props.className ?? '')?.[1] ?? ''
      const raw = typeof props.children === 'string' ? props.children : ''
      // mermaid 的 diagram 分支挂在 Streamdown **内部 code 组件**上：这里必须把 children 原样透传回去，
      // 截成 CodeFence 就只剩一个带复制/下载的代码块。透传时补上默认 pre 的职责——
      // 内部 code 组件靠 `data-block` 区分块级/行内，丢了标记 mermaid 会退化成行内纯文本。
      if (language === 'mermaid') {
        return cloneElement(child as ReactElement<Record<string, unknown>>, {
          'data-block': 'true',
        })
      }
      // 自定义围栏（json / html / gsap / xflow）仍交给各自组件渲染，不能当普通代码块
      if (raw && RENDERED_FENCE_LANGUAGES.includes(language)) {
        const renderer = markdownFenceRenderers.find((item) =>
          Array.isArray(item.language)
            ? item.language.includes(language)
            : item.language === language,
        )
        if (renderer) {
          const Fence = renderer.component as unknown as ComponentType<Record<string, unknown>>
          return <Fence code={raw.replace(/\n$/, '')} language={language} isIncomplete={false} />
        }
      }
      if (raw) return <CodeFence code={raw.replace(/\n$/, '')} language={language} />
    }
    return <PlainPre>{children}</PlainPre>
  },
  /**
   * 表格：**列宽按内容走，短列不折行**。
   *
   * 之前是 `w-full` + 单元格换行，本意是"不出现横向滚动"，结果 6 列挤进容器后连
   * 「排名」「题材标签」这种两个字的表头都被拆成两行（2026-11-21 反馈）。
   * 现在：
   * - 表头一律 `whitespace-nowrap`（表头宽度就是这个列的下限）；
   * - `w-max min-w-full`：列按内容取宽，容器更宽时再铺满，不再为了塞下而压缩短列；
   * - 单元格内容套一层 `max-w-[22rem]` 的盒子：只有长说明（研究报告里的"核心数据"那种）
   *   才会折行，且折在一个可读的宽度里；再宽就让整个表横向滚动。
   */
  table: ({ children }: { children?: ReactNode }) => (
    <div className="my-3 w-full overflow-x-auto">
      <table className="w-max min-w-full table-auto border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: ReactNode }) => <thead>{children}</thead>,
  tbody: ({ children }: { children?: ReactNode }) => <tbody>{children}</tbody>,
  tr: ({ children }: { children?: ReactNode }) => (
    <tr className="border-border/60 border-b last:border-0">{children}</tr>
  ),
  th: ({ children }: { children?: ReactNode }) => (
    <th className="px-3 py-2 text-left align-top font-medium whitespace-nowrap text-muted-foreground">
      {children}
    </th>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td className="px-3 py-2 align-top">
      <div className="max-w-[22rem] whitespace-normal break-words">{children}</div>
    </td>
  ),
}

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn('size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', className)}
      plugins={streamdownPlugins}
      components={streamdownComponents}
      // 正文里不带行号：聊天里的代码是"读"的，不是"讨论第 12 行"的；而语言是 text 的那种
      // 字符画（架构图、树形图）被行号挤窄后更难读，多出来的数字栏也让人以为看的是源码。
      // 需要行号时调用方传 `lineNumbers` 覆盖即可。
      lineNumbers={false}
      {...props}
    />
  ),
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children && nextProps.isAnimating === prevProps.isAnimating,
)

MessageResponse.displayName = 'MessageResponse'

export type MessageToolbarProps = ComponentProps<'div'>

export const MessageToolbar = ({ className, children, ...props }: MessageToolbarProps) => (
  <div className={cn('mt-4 flex w-full items-center justify-between gap-4', className)} {...props}>
    {children}
  </div>
)
