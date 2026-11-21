'use client'

import Link from 'next/link'
import { useState } from 'react'
import type { AgentConversationModel } from '@repo/shared'
import {
  Button,
  ConfirmAction,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconText,
  cn,
} from '@repo/ui'
import {
  ChevronRightIcon,
  FolderIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  UserRoundIcon,
} from 'lucide-react'
import { relativeTimeText } from './format'
import { conversationPath } from './routes'

/**
 * 会话列表的**一份实现，两处挂载**：桌面左侧栏（`variant='sidebar'`）与手机抽屉
 * （`variant='drawer'`）。
 *
 * 为什么不各写一遍（2026-11-21 的返工原因）：手机抽屉原先自己写了一套扁平列表 ——
 * 没有工作区分组、没有「在工作区下建会话」、没有删除工作区，桌面上有的东西手机上全缺；
 * 两份实现各改各的，必然漂移。现在分组 / 折叠 / 分页 / 行菜单都在这里，抽屉只是换一种行排布。
 *
 * 两处**有意不同**的只有三处，都靠在 `variant` 上：
 * - 行内容：桌面一行（标题 + 相对时间，悬停换操作图标）；抽屉两行（标题 + 轮数），
 *   因为触摸没有 hover，时间那格没法"悬停换按钮"；
 * - 行菜单：抽屉里常显（`persistent`）—— 触摸看不到 `opacity-0`；
 * - 组标题右侧的工作区操作（建会话 / 删工作区）：桌面悬停才出现，抽屉常显并放大热区。
 *
 * 其余（检索「未分组」、折叠态、空态、加载更多、到底提示）**同一套代码**。
 */

/** 一个分组 = 一个工作区（或「未分组」） */
export interface ConversationGroup {
  key: string
  workspaceId: string | null
  name: string
  ownerId: string | null
  ownerName: string | null
  conversations: AgentConversationModel[]
}

/** 分页 / 空态需要的状态位（由布局传进来，列表自己不查数据） */
export interface ConversationListState {
  /** 已加载会话总数（含未分组） */
  count: number
  isLoading: boolean
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onLoadMore: () => void
}

export interface ConversationGroupListProps {
  variant: 'sidebar' | 'drawer'
  groups: ConversationGroup[]
  /** 折叠的分组 key */
  collapsed: ReadonlySet<string>
  onToggleGroup: (key: string) => void
  pathname: string
  /** 当前登录用户 id（判断工作区归属显示） */
  me: string | null | undefined
  list: ConversationListState
  /** 点会话后的回调（抽屉用它关掉抽屉；桌面不传） */
  onNavigate?: () => void
  onRename: (conversation: AgentConversationModel) => void
  onDelete: (conversation: AgentConversationModel) => void
  onCreateInWorkspace: (workspaceId: string) => void
  onDeleteWorkspace: (workspaceId: string) => Promise<void> | void
  deleteWorkspacePending: boolean
}

/**
 * 会话行的「更多」操作：**鼠标移入即打开菜单**（点开也行）。
 *
 * 抽成组件是因为要用 `useState` 控制 open —— 在列表 map 里不能直接用 hooks。
 * 菜单在 Portal 里，移出触发区不立刻关（否则指针一进菜单就被判离开），
 * 由菜单自己的 pointerleave / 选中 / Esc / 点外面关闭。
 *
 * `persistent` 是给**手机端会话抽屉**用的（桌面永远不传 = 沿用下面这套悬停显隐，一字未变）：
 * 触摸设备没有 hover，`opacity-0` 的入口既看不见也点不到；而且触点会先触发 pointerenter
 * 再触发 click，若仍挂着"移入即打开"，菜单刚开就被 trigger 的 click 关掉 —— 所以
 * persistent 下既不淡出，也不注册 pointerenter。
 */
function ConversationMenu(props: {
  conversation: AgentConversationModel
  onRename: (conversation: AgentConversationModel) => void
  onDelete: (conversation: AgentConversationModel) => void
  /** 窄屏抽屉：常显、可点（触摸没有 hover），并放大触发器的热区 */
  persistent?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className={cn(
        'absolute inset-y-1 right-1 flex items-center rounded-md px-0.5 transition-opacity',
        props.persistent
          ? 'pointer-events-auto opacity-100'
          : 'pointer-events-none bg-surface-4 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100',
      )}
      onPointerEnter={props.persistent ? undefined : () => setOpen(true)}
    >
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="更多会话操作"
              className={cn(
                'inline-flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-3 hover:text-foreground',
                // 手机上 24px 的图标按钮偏小，给到 28px（抽屉是窄屏专用，桌面仍是 size-6）
                props.persistent ? 'size-7' : 'size-6',
              )}
            >
              <MoreHorizontalIcon className="size-3.5" />
            </button>
          }
        />
        <DropdownMenuContent
          align="end"
          className="w-32"
          onPointerLeave={props.persistent ? undefined : () => setOpen(false)}
        >
          <DropdownMenuItem
            onClick={() => {
              setOpen(false)
              props.onRename(props.conversation)
            }}
          >
            <PencilIcon className="size-3.5" />
            重命名
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => {
              setOpen(false)
              props.onDelete(props.conversation)
            }}
          >
            <Trash2Icon className="size-3.5" />
            删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function ConversationGroupList({
  variant,
  groups,
  collapsed,
  onToggleGroup,
  pathname,
  me,
  list,
  onNavigate,
  onRename,
  onDelete,
  onCreateInWorkspace,
  onDeleteWorkspace,
  deleteWorkspacePending,
}: ConversationGroupListProps) {
  const drawer = variant === 'drawer'
  /**
   * 是否**已全部加载**。分组与组内计数都是从已加载的 `items` 算出来的，
   * 还没翻完页时某个工作区可能是"这一页里没有"而不是"真的空" —— 那种时候既不给计数
   * 也不说"还没有会话"，否则用户会以为会话丢了（桌面侧栏没有这些提示，不受影响）。
   */
  const fullyLoaded = !list.hasNextPage

  return (
    <>
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.key)
        return (
          <div key={group.key} className="flex flex-col pb-1">
            {/*
              组头（工作区名）在桌面侧栏**吸顶**：会话多时滚动中要一直能看出"现在这一组是谁"。
              吸顶底色必须是导轨色本身（`surface-3`）；抽屉里背景不是导轨色，吸顶反而会贴块错色，
              所以只在桌面挂 sticky（抽屉本来就是短列表）。
            */}
            <div
              className={cn(
                'group/ws flex items-center gap-1 rounded-md px-1 py-1.5 hover:bg-surface-2',
                !drawer && 'sticky top-0 z-10 bg-surface-3',
              )}
            >
              <button
                type="button"
                aria-expanded={!isCollapsed}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-1 text-left',
                  // 抽屉里这一行是触摸目标：抬高到 ~36px（桌面保持原高度）
                  drawer && 'py-1',
                )}
                onClick={() => onToggleGroup(group.key)}
              >
                <ChevronRightIcon
                  className={cn(
                    'size-3 shrink-0 text-muted-foreground transition-transform',
                    !isCollapsed && 'rotate-90',
                  )}
                />
                <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate font-medium text-muted-foreground',
                    // 抽屉字号比桌面大一档：11px 在手机上读着吃力
                    drawer ? 'text-xs' : 'text-[11px]',
                  )}
                >
                  {group.name}
                </span>
                {/* 抽屉里给出组内会话数：空工作区一眼能看出是"还没建会话"而不是"没加载出来"
                    （只在已全部加载时给，理由见 `fullyLoaded`） */}
                {drawer && fullyLoaded ? (
                  <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                    {group.conversations.length}
                  </span>
                ) : null}
                {group.ownerId && group.ownerId !== me ? (
                  <IconText
                    icon={<UserRoundIcon />}
                    size="small"
                    tooltip={`所属用户：${group.ownerName ?? group.ownerId}`}
                    aria-label={`所属用户：${group.ownerName ?? group.ownerId}`}
                  />
                ) : null}
              </button>
              {group.workspaceId ? (
                <div
                  className={cn(
                    'flex items-center',
                    // 桌面：悬停 / 聚焦才出现；抽屉：常显 + 放大热区（触摸没有 hover）
                    drawer
                      ? 'gap-1'
                      : 'gap-0.5 opacity-0 transition-opacity group-hover/ws:opacity-100 focus-within:opacity-100',
                  )}
                >
                  <IconText
                    icon={<PlusIcon />}
                    size="small"
                    // 抽屉里这个「+」是触摸目标：给到 32px 方形热区（桌面保持原来的小图标）
                    className={drawer ? 'size-8 justify-center' : undefined}
                    tooltip="在此工作区新建会话"
                    aria-label="在此工作区新建会话"
                    onClick={() => onCreateInWorkspace(group.workspaceId!)}
                  />
                  <ConfirmAction
                    danger
                    title="删除这个工作区？"
                    description="工作区会被软删，容器随之销毁；里面的会话保留，但不再归属它。"
                    disabled={deleteWorkspacePending}
                    onConfirm={() => onDeleteWorkspace(group.workspaceId!)}
                  >
                    {/*
                      `ConfirmAction` 内部固定渲染成 `IconText` 并把 children 原样塞进去，
                      外面没法直接放大热区 —— 抽屉里套一层 28px 的方形 span，让这颗删除图标
                      与旁边的「+」一样好点（桌面不套，保持原来的 14px 图标）
                    */}
                    {drawer ? (
                      <span className="flex size-7 items-center justify-center">
                        <Trash2Icon className="size-4" />
                      </span>
                    ) : (
                      <Trash2Icon className="size-3.5" />
                    )}
                  </ConfirmAction>
                </div>
              ) : null}
            </div>

            {/* 分组内容：抽屉里空工作区给一句提示，否则"展开也是空的"看着像坏了 */}
            {!isCollapsed ? (
              group.conversations.length === 0 && drawer && fullyLoaded && group.workspaceId ? (
                <p className="px-2 pb-1 pl-7 text-[11px] text-muted-foreground">
                  还没有会话，点这个工作区右侧的 + 新建
                </p>
              ) : null
            ) : null}

            {!isCollapsed &&
              group.conversations.map((conversation) => {
                const active = pathname === conversationPath(conversation.id)
                // 相对时间（用户口径）：列表扫的是"新旧"，不是具体时刻 ——
                // 超过一周自动回落成日期（见 `relativeTimeText`）
                const time = relativeTimeText(conversation.updatedAt ?? conversation.createdAt)
                return (
                  // 行操作（改名 / 删除）是 `<Link>` 的**兄弟节点**、不是子节点：
                  // 嵌在 Link 里的话，点操作会连带触发跳转 —— `ConfirmAction` 的触发自带 onClick，
                  // 没有留给调用方 `preventDefault` 的口子
                  <div key={conversation.id} className="group relative">
                    {drawer ? (
                      /*
                        抽屉行：标题 + 轮数两行。触摸没有 hover，所以「更多」常显（右侧留 pr-10），
                        `active:` 是按下反馈 —— 点下去要立刻有反应，否则像没点中。
                        时间那格在手机上不显示：两行里再挤时间会把标题截短，轮数才是列表里更有用的信息。
                      */
                      <Link
                        href={conversationPath(conversation.id)}
                        aria-current={active ? 'page' : undefined}
                        onClick={onNavigate}
                        className={cn(
                          'flex flex-col gap-0.5 rounded-md py-2 pr-10 pl-3 text-sm',
                          active ? 'bg-surface-4' : 'hover:bg-surface-4/60 active:bg-surface-4',
                        )}
                      >
                        <span className="truncate font-medium">
                          {conversation.title || '(无标题)'}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          {conversation.running ? '运行中 · ' : ''}
                          {conversation.turnCount} 轮
                        </span>
                      </Link>
                    ) : (
                      /*
                        桌面行（一行式，对齐 DSH）：标题在左、时间在右，悬停时**同一位置**换成操作 icon。
                        为什么不再显示「N 轮」：一行只有一份右对齐的信息，时间才是用户扫列表的判据；
                        轮数是过程指标，要看就进会话看。token 累计同理，属于会话详情，不塞列表行。
                      */
                      <Link
                        href={conversationPath(conversation.id)}
                        aria-current={active ? 'page' : undefined}
                        onClick={onNavigate}
                        className={cn(
                          // 选中态是一张**白卡**（导轨是 `surface-3`）：明度差把"当前会话"从
                          // 一排灰底条目里拎出来，比再用一档灰（`surface-4`，只差 1%）有效得多。
                          'flex w-full items-center gap-2 rounded-lg py-2 pr-2 pl-9 text-left text-sm',
                          'transition-colors hover:bg-card/70',
                          active && 'bg-card text-foreground',
                        )}
                      >
                        {/* 运行中：一行放不下「运行中」三个字，只留一个呼吸点（语义用 sr-only 补） */}
                        {conversation.running ? (
                          <span className="relative flex size-1.5 shrink-0" title="运行中">
                            <span
                              className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75"
                              aria-hidden
                            />
                            <span
                              className="relative inline-flex size-1.5 rounded-full bg-success"
                              aria-hidden
                            />
                            <span className="sr-only">运行中</span>
                          </span>
                        ) : null}
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {conversation.title || '(无标题)'}
                        </span>
                        {time ? (
                          <span className="shrink-0 text-xs text-muted-foreground group-hover:invisible">
                            {time}
                          </span>
                        ) : null}
                      </Link>
                    )}
                    {/*
                      操作：悬停 / 键盘聚焦时出现「更多」按钮，点开才是菜单 ——
                      比两个常驻图标安静，也不会把短时间文案挤成两行。
                    */}
                    <ConversationMenu
                      conversation={conversation}
                      onRename={onRename}
                      onDelete={onDelete}
                      persistent={drawer}
                    />
                  </div>
                )
              })}
          </div>
        )
      })}

      {list.count === 0 && !list.isLoading ? (
        <p className="p-3 text-xs text-muted-foreground">还没有会话</p>
      ) : null}
      {list.isLoading ? <p className="p-3 text-xs text-muted-foreground">正在加载会话…</p> : null}
      {list.hasNextPage ? (
        <div className="flex justify-center p-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={list.isFetchingNextPage}
            onClick={() => list.onLoadMore()}
          >
            {list.isFetchingNextPage ? '正在加载…' : '加载更多会话'}
          </Button>
        </div>
      ) : list.count > 0 ? (
        <p className="p-3 text-center text-[11px] text-muted-foreground">
          共 {list.count} 个会话，已经到底了
        </p>
      ) : null}
    </>
  )
}
