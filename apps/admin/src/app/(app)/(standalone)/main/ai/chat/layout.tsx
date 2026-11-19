'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { usePathname } from 'next/navigation'
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query'
import { useForm } from '@tanstack/react-form'
import {
  Button,
  ConfirmAction,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconText,
  Input,
  Label,
  ModalForm,
  RefreshButton,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  cn,
  toastSuccess,
  useDisclosure,
  useIsMobile,
  useStream,
} from '@repo/ui'
import {
  STREAM_CONVERSATION_RUN_CHANGED_EVENT,
  STREAM_CONVERSATION_RUN_STARTED_EVENT,
  STREAM_CONVERSATION_TITLE_CHANGED_EVENT,
  ConversationRunChangedEventSchema,
  ConversationRunStartedEventSchema,
  ConversationTitleChangedEventSchema,
  type AgentConversationModel,
  type AppPageQueryResponse,
  type WorkspaceModel,
} from '@repo/shared'
// 可拖动分栏：`components/ui/*` 属重型基础组件，走子路径按需引入（不进 barrel，带扩展名）
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePanelRef,
} from '@repo/ui/components/ui/resizable.tsx'
import {
  ChevronRightIcon,
  FolderIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react'
import { useServerClient } from '@/lib/server-client'
import { relativeTimeText } from './format'
import { conversationPath, newConversationPath, CHAT_ROOT } from './routes'
import { ChatMobileNavContext } from './mobile-nav-context'

/**
 * 会话页的**外层壳**：左侧会话列表（库里的真相），右侧对话区。
 *
 * 为什么做成路由的 `layout`（而不是页面里的一个 `<aside>`）：
 * 会话列表**不随会话切换重挂载** —— 切换会话只换右侧内容，
 * 列表的滚动位置、TanStack Query 的缓存、刷新按钮的状态都保持原样；
 * 同时"每个会话一个地址"由 `<Link href>` 表达（可新开标签、可前进后退）。
 *
 * 列表的真相来自 `POST /agent/conversation/list`；页面在首轮问答后
 * `invalidateQueries(['ai','conversations'])` 刷新它（同一个 QueryClient，不需要 prop 传递）。
 *
 * 布局口径（两条都踩过）：
 * - **铺满内容区**：不写 `mx-auto max-w-*` —— 宽屏下那会把整页收窄成中间一条、两侧留大白；
 *   由内容区自己撑满，滚动与换行交给内部容器处理。
 * - **分栏可拖动**：两栏之间是可拖动的分隔条（`@repo/ui` 的 resizable，即 shadcn 封装的
 *   `react-resizable-panels`）。列表栏按**像素**保持宽度（`preserve-pixel-size`），
 *   窗口变宽时由对话区吸收 —— 列表是"栏"，不该跟着窗口等比变宽。
 */

/** 会话列表栏的默认 / 最小 / 最大宽度（数字即像素） */
const SIDEBAR_WIDTH = { default: 264, min: 180, max: 420 } as const

/** 会话列表每页条数；触底自动取下一页（会话可能几十上百条，不能只拉第一页） */
const CONVERSATION_PAGE_SIZE = 30

export default function ChatLayout({ children }: { children: ReactNode }) {
  const client = useServerClient()
  const pathname = usePathname()
  const router = useRouter()
  const queryClient = useQueryClient()
  const renameDialog = useDisclosure<AgentConversationModel>()
  const conversationsQuery = useInfiniteQuery({
    queryKey: ['ai', 'conversations'],
    queryFn: ({ pageParam }) =>
      client.agent.conversation.list({
        page: pageParam,
        size: CONVERSATION_PAGE_SIZE,
        includeDeleted: false,
      }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.page * lastPage.size < lastPage.total ? lastPage.page + 1 : undefined,
  })

  /**
   * 运行态**事件驱动**：服务端在根 run 的活跃状态变化时推 `conversation.run.changed`
   * （频道 `ai:owner:{ownerId}`，由服务端按登录身份派生订阅，客户端不传频道）。
   *
   * 原先是「缓存里有 running 才每 5s 拉一次列表」的**条件轮询** —— 拿定时器去猜服务端状态。
   * 而状态变化点全在服务端（开跑 / 收尾 / 挂起 / 停止 / 看门狗判超时 / 重启恢复 / 删会话），
   * 事件本来就该负责这件事；现在空闲时零请求、跑完立刻灭灯。
   *
   * 收到事件只**覆盖 `running` 一个字段**，不整份重拉；但"跑完了"还要顺带刷新标题 / 轮数 /
   * 排序（收尾时一起变），所以 `running=false` 时补一次失效 —— 一次运行结束只多一个请求。
   */
  const stream = useMemo(() => client.createStream(), [client])
  const { state: streamState } = useStream(stream, {
    [STREAM_CONVERSATION_RUN_CHANGED_EVENT]: (raw) => {
      const parsed = ConversationRunChangedEventSchema.safeParse(raw)
      if (!parsed.success) return
      const { conversationId, running } = parsed.data
      const cached = queryClient.getQueryData<
        InfiniteData<AppPageQueryResponse<AgentConversationModel>>
      >(['ai', 'conversations'])
      const known =
        cached?.pages.some((page) => page.items.some((item) => item.id === conversationId)) ?? false
      queryClient.setQueryData<InfiniteData<AppPageQueryResponse<AgentConversationModel>>>(
        ['ai', 'conversations'],
        (current) =>
          current
            ? {
                ...current,
                pages: current.pages.map((page) => ({
                  ...page,
                  items: page.items.map((item) =>
                    item.id === conversationId ? { ...item, running } : item,
                  ),
                })),
              }
            : current,
      )
      queryClient.setQueryData<AgentConversationModel>(
        ['ai', 'conversation', conversationId],
        (current) => (current ? { ...current, running } : current),
      )
      // 两种情况补一次列表：
      // - 跑完了：标题 / 轮数 / 排序在收尾时一起变，只改 running 不够；
      // - 这条会话不在缓存里（别的标签页新建的）：光改字段加不出一行来。
      // 缓存还没建立时不补：初始请求本来就会把真相带回来。
      if (!running || (cached && !known)) {
        void queryClient.invalidateQueries({ queryKey: ['ai', 'conversations'] })
      }
      // 运行态变了 → 会话页那份"当前是否有活动 run"的对账查询立刻重拉一次：
      // 排队消息 / 子 agent 唤醒是**服务端自己起跑**的，页面只能靠这一步接回流。
      void queryClient.invalidateQueries({ queryKey: ['ai', 'active-run', conversationId] })
    },
    /**
     * 首轮命名的结果：命名与主回答**并行**跑，名字可能比回答先到。
     *
     * 只改标题这一个字段（列表行 + 会话详情各一处），不整份重拉 —— 名字变了不代表
     * 轮数 / 排序 / 运行态变了，那些由 `conversation.run.changed` 负责。
     * 会话不在缓存里（别的标签页刚建）就失效重拉，否则光改字段加不出一行来。
     */
    [STREAM_CONVERSATION_TITLE_CHANGED_EVENT]: (raw) => {
      const parsed = ConversationTitleChangedEventSchema.safeParse(raw)
      if (!parsed.success) return
      const { conversationId, title } = parsed.data
      const cached = queryClient.getQueryData<
        InfiniteData<AppPageQueryResponse<AgentConversationModel>>
      >(['ai', 'conversations'])
      const known =
        cached?.pages.some((page) => page.items.some((item) => item.id === conversationId)) ?? false
      queryClient.setQueryData<InfiniteData<AppPageQueryResponse<AgentConversationModel>>>(
        ['ai', 'conversations'],
        (current) =>
          current
            ? {
                ...current,
                pages: current.pages.map((page) => ({
                  ...page,
                  items: page.items.map((item) =>
                    item.id === conversationId ? { ...item, title } : item,
                  ),
                })),
              }
            : current,
      )
      queryClient.setQueryData<AgentConversationModel>(
        ['ai', 'conversation', conversationId],
        (current) => (current ? { ...current, title } : current),
      )
      if (cached && !known) {
        void queryClient.invalidateQueries({ queryKey: ['ai', 'conversations'] })
      }
    },
    /**
     * 新开一轮：排队中的用户消息 / 子 agent 完成唤醒在服务端起跑时**没有前端连接**。
     * 收到事件就把该会话标成 running，并让会话页去 `/agent/run/stream` 接流；
     * 不在这里直接 resume：布局层不持有 `useChat` 实例，接流归会话页（`chat-conversation`）。
     */
    [STREAM_CONVERSATION_RUN_STARTED_EVENT]: (raw) => {
      const parsed = ConversationRunStartedEventSchema.safeParse(raw)
      if (!parsed.success) return
      const { conversationId } = parsed.data
      queryClient.setQueryData<AgentConversationModel>(
        ['ai', 'conversation', conversationId],
        (current) => (current ? { ...current, running: true } : current),
      )
      void queryClient.invalidateQueries({ queryKey: ['ai', 'active-run', conversationId] })
      void queryClient.invalidateQueries({ queryKey: ['ai', 'conversations'] })
    },
  })

  /**
   * 重连后的**对账**：推流是 at-most-once（服务端不做回放），而页面隐藏时连接会断开
   * （`HttpStreamClient` 默认 `openWhenHidden: false`）—— 切标签页是常态，断线期间的事件会丢。
   * 所以每次重新 `open` 都补拉一次列表：这不是轮询，是"连上先对齐真相"。
   *
   * 首次 `open` 跳过：挂载时列表本来就在拉，不必多打一次。
   */
  const streamOpened = useRef(false)
  useEffect(() => {
    if (streamState !== 'open') return
    if (!streamOpened.current) {
      streamOpened.current = true
      return
    }
    void queryClient.invalidateQueries({ queryKey: ['ai', 'conversations'] })
  }, [streamState, queryClient])

  /**
   * 改名 / 删除后要刷新的两份缓存：
   * - 侧栏列表（标题、有没有这条）；
   * - 该会话的详情（页头标题、agentKey）。
   */
  const invalidateConversation = (conversationId: string) => {
    void queryClient.invalidateQueries({ queryKey: ['ai', 'conversations'] })
    void queryClient.invalidateQueries({
      queryKey: ['ai', 'conversation', conversationId],
    })
  }

  const renameMutation = useMutation({
    mutationFn: (input: { conversationId: string; title: string }) =>
      client.agent.conversation.rename(input),
    onSuccess: (conversation) => {
      invalidateConversation(conversation.id)
      toastSuccess('已重命名')
      renameDialog.close()
    },
  })

  const removeMutation = useMutation({
    mutationFn: (conversationId: string) => client.agent.conversation.remove({ conversationId }),
    onSuccess: (_result, conversationId) => {
      invalidateConversation(conversationId)
      toastSuccess('已删除会话')
      // 删掉的正是当前打开的那个 → 回到「新会话」，别停在一个已经打不开的地址上
      if (pathname === conversationPath(conversationId)) router.push(newConversationPath())
    },
  })

  const renameForm = useForm({
    defaultValues: { title: '' },
    onSubmit: async ({ value }) => {
      const target = renameDialog.data
      if (!target) return
      await renameMutation.mutateAsync({
        conversationId: target.id,
        title: value.title,
      })
    },
  })

  const items = useMemo(
    () => conversationsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [conversationsQuery.data],
  )
  const isNewRoute = pathname === newConversationPath()
  const isRoot = pathname === CHAT_ROOT

  // ── 工作区：会话页左侧按工作区分组，可直接在工作区下建会话 ──
  const workspacesQuery = useQuery<WorkspaceModel[]>({
    queryKey: ['workspaces'],
    queryFn: () => client.workspace.list(),
  })
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false)
  const [workspaceName, setWorkspaceName] = useState('')
  // 折叠的工作区（点文件夹名收起 / 展开）
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggleGroup = (key: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const groups = useMemo(() => {
    const workspaceList = workspacesQuery.data ?? []
    const byId = new Map<string, AgentConversationModel[]>()
    const ungrouped: AgentConversationModel[] = []
    for (const conversation of items) {
      if (conversation.workspaceId) {
        const list = byId.get(conversation.workspaceId) ?? []
        list.push(conversation)
        byId.set(conversation.workspaceId, list)
      } else {
        ungrouped.push(conversation)
      }
    }
    const result: Array<{
      key: string
      workspaceId: string | null
      name: string
      conversations: AgentConversationModel[]
    }> = workspaceList.map((workspace) => ({
      key: workspace.id,
      workspaceId: workspace.id,
      name: workspace.isDefault ? `${workspace.name}（默认）` : workspace.name,
      conversations: byId.get(workspace.id) ?? [],
    }))
    if (ungrouped.length > 0) {
      result.push({ key: 'ungrouped', workspaceId: null, name: '未分组', conversations: ungrouped })
    }
    return result
  }, [items, workspacesQuery.data])

  const createInWorkspace = useMutation({
    mutationFn: (workspaceId: string) => client.agent.conversation.create({ workspaceId }),
    onSuccess: async (conversation) => {
      await queryClient.invalidateQueries({ queryKey: ['ai', 'conversations'] })
      router.push(conversationPath(conversation.id))
    },
  })

  const createWorkspace = useMutation({
    mutationFn: () => client.workspace.create({ name: workspaceName.trim() || undefined }),
    onSuccess: async () => {
      toastSuccess('工作区已创建')
      setCreateWorkspaceOpen(false)
      setWorkspaceName('')
      await queryClient.invalidateQueries({ queryKey: ['workspaces'] })
    },
  })

  const removeWorkspace = useMutation({
    mutationFn: (workspaceId: string) => client.workspace.remove({ id: workspaceId }),
    onSuccess: async () => {
      toastSuccess('工作区已删除')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workspaces'] }),
        queryClient.invalidateQueries({ queryKey: ['ai', 'conversations'] }),
      ])
    },
  })

  /**
   * 触底加载下一页。会话可能有几十条，第一页永远只有 20/30 条；
   * 不取下一页时用户滚到底会以为“列表就这些了”。
   */
  const handleListScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    if (element.scrollHeight - element.scrollTop - element.clientHeight > 80) return
    if (!conversationsQuery.hasNextPage || conversationsQuery.isFetchingNextPage) return
    void conversationsQuery.fetchNextPage()
  }
  // 窄屏（<1024px）不放列表栏：分栏需要宽度，手机上两栏都挤成一条
  // （`useIsMobile` 首帧与 SSR 一致返回 false，挂载后再纠正 —— 与 Sidebar 同一套口径）
  const isMobile = useIsMobile()

  useEffect(() => {
    // 手机端点会话后地址变化，抽屉自动收起
    setMobileListOpen(false)
  }, [pathname])

  // 会话列表可收起：分栏本身留在原来的位置，宽度收到 0，右侧对话区不卸载（页面状态不丢）
  const sidebarRef = usePanelRef()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileListOpen, setMobileListOpen] = useState(false)

  const collapseSidebar = () => {
    if (!sidebarRef.current) return
    sidebarRef.current.collapse()
    setSidebarCollapsed(true)
  }

  const expandSidebar = () => {
    if (!sidebarRef.current) return
    sidebarRef.current.expand()
    setSidebarCollapsed(false)
  }

  return (
    <>
      <ChatMobileNavContext.Provider value={{ openConversations: () => setMobileListOpen(true) }}>
        <>
          <ResizablePanelGroup orientation="horizontal" className="h-full w-full">
            {/* 左：会话列表（拖右缘改宽度）。面板自身不滚动 —— 滚动交给列表，否则会出现第二条滚动条 */}
            {isMobile ? null : (
              <>
                <ResizablePanel
                  panelRef={sidebarRef}
                  collapsible
                  collapsedSize={0}
                  defaultSize={SIDEBAR_WIDTH.default}
                  minSize={SIDEBAR_WIDTH.min}
                  maxSize={SIDEBAR_WIDTH.max}
                  groupResizeBehavior="preserve-pixel-size"
                  onResize={(panelSize: { inPixels: number }) =>
                    setSidebarCollapsed(panelSize.inPixels < 2)
                  }
                  className="h-full"
                  // 把高度钉死：分栏库给内容层的是 max-height，不是 height；不显式给 100% 时
                  // 内容层可能按内容撑开，内部 overflow-y-auto 就永远不出现滚动条
                  style={{ overflow: 'hidden', height: '100%', minHeight: 0 }}
                >
                  {sidebarCollapsed ? null : (
                    <aside className="flex h-full min-h-0 w-full flex-col gap-2 overflow-hidden bg-surface-3 p-3">
                      {/* 顶层「会话 / 管理」切换在全局顶栏里（两棵布局树共用一条）——
                    列表栏不再自带「返回管理台」入口，这一行只放会话自己的操作，
                    省下来的一行高度全给会话列表（会话页最紧的就是竖直空间） */}
                      <div className="flex items-center gap-2">
                        {/* 会话在工作区下建（每个文件夹的「+」）；这里统一入口是「新建工作区」 */}
                        <Button
                          size="sm"
                          className="min-w-0 flex-1 justify-center gap-1.5"
                          onClick={() => setCreateWorkspaceOpen(true)}
                        >
                          <PlusIcon className="size-3.5" />
                          新建工作区
                        </Button>
                        <RefreshButton onClick={() => void conversationsQuery.refetch()} />
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={collapseSidebar}
                          title="收起会话列表"
                          aria-label="收起会话列表"
                        >
                          <PanelLeftCloseIcon className="size-3.5" />
                        </Button>
                      </div>
                      {/* 列表不画外框也不画行分隔线：选中 / 悬停用底色区分，分隔交给中间那根分隔条 */}
                      <div
                        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
                        onScroll={handleListScroll}
                      >
                        {groups.map((group) => (
                          <div key={group.key} className="flex flex-col pb-1">
                            <div className="group/ws flex items-center gap-1 rounded-md px-1 py-1.5 hover:bg-surface-2">
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 items-center gap-1 text-left"
                                onClick={() => toggleGroup(group.key)}
                              >
                                <ChevronRightIcon
                                  className={cn(
                                    'size-3 shrink-0 text-muted-foreground transition-transform',
                                    !collapsed.has(group.key) && 'rotate-90',
                                  )}
                                />
                                <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                                <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">
                                  {group.name}
                                </span>
                              </button>
                              {group.workspaceId ? (
                                <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/ws:opacity-100 focus-within:opacity-100">
                                  <IconText
                                    icon={<PlusIcon />}
                                    size="small"
                                    tooltip="在此工作区新建会话"
                                    aria-label="在此工作区新建会话"
                                    onClick={() => createInWorkspace.mutate(group.workspaceId!)}
                                  />
                                  <ConfirmAction
                                    danger
                                    title="删除这个工作区？"
                                    description="工作区会被软删，容器随之销毁；里面的会话保留，但不再归属它。"
                                    disabled={removeWorkspace.isPending}
                                    onConfirm={async () => {
                                      await removeWorkspace.mutateAsync(group.workspaceId!)
                                    }}
                                  >
                                    <Trash2Icon className="size-3.5" />
                                  </ConfirmAction>
                                </div>
                              ) : null}
                            </div>
                            {!collapsed.has(group.key) &&
                              group.conversations.map((conversation) => {
                                const active = pathname === conversationPath(conversation.id)
                                // 相对时间（用户口径）：列表扫的是"新旧"，不是具体时刻 ——
                                // 超过一周自动回落成日期（见 `relativeTimeText`）
                                const time = relativeTimeText(
                                  conversation.updatedAt ?? conversation.createdAt,
                                )
                                return (
                                  // 行操作（改名 / 删除）是 `<Link>` 的**兄弟节点**、不是子节点：
                                  // 嵌在 Link 里的话，点操作会连带触发跳转 —— `ConfirmAction` 的触发自带 onClick，
                                  // 没有留给调用方 `preventDefault` 的口子
                                  <div key={conversation.id} className="group relative">
                                    {/*
                              一行式（对齐 DSH）：标题在左、时间在右，悬停时**同一位置**换成操作 icon。
                              为什么不再显示「N 轮」：一行只有一份右对齐的信息，时间才是用户扫列表的判据；
                              轮数是过程指标，要看就进会话看。token 累计同理，属于会话详情，不塞列表行。
                            */}
                                    <Link
                                      href={conversationPath(conversation.id)}
                                      aria-current={active ? 'page' : undefined}
                                      className={cn(
                                        'flex w-full items-center gap-2 rounded-md py-2 pr-2 pl-9 text-left text-sm',
                                        'transition-colors hover:bg-surface-4/60',
                                        active && 'bg-surface-4',
                                      )}
                                    >
                                      {/* 运行中：一行放不下「运行中」三个字，只留一个呼吸点（语义用 sr-only 补） */}
                                      {conversation.running ? (
                                        <span
                                          className="relative flex size-1.5 shrink-0"
                                          title="运行中"
                                        >
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
                                    {/*
                              操作：悬停 / 键盘聚焦时**盖在时间的位置上**出现。
                              自带一层 `bg-surface-4` 底色：遇到"刚刚"这种很短的文案，操作区会比时间宽，
                              没底色就会直接压到标题上（看起来像标题少了一截）。
                            */}
                                    <div className="pointer-events-none absolute inset-y-1 right-1 flex items-center gap-0.5 rounded-md bg-surface-4 px-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
                                      <IconText
                                        icon={<PencilIcon />}
                                        size="small"
                                        type="primary"
                                        aria-label="重命名会话"
                                        tooltip="重命名"
                                        onClick={() => {
                                          renameForm.reset({ title: conversation.title })
                                          renameDialog.open(conversation)
                                        }}
                                      />
                                      <ConfirmAction
                                        danger
                                        title="删除这个会话？"
                                        description="会话会被软删除（列表里不再显示）；运行记录与时间线保留，审计页仍可查。"
                                        disabled={removeMutation.isPending}
                                        onConfirm={async () => {
                                          await removeMutation.mutateAsync(conversation.id)
                                        }}
                                      >
                                        <Trash2Icon className="size-3.5" />
                                      </ConfirmAction>
                                    </div>
                                  </div>
                                )
                              })}
                          </div>
                        ))}
                        {items.length === 0 && !conversationsQuery.isLoading && (
                          <p className="p-3 text-xs text-muted-foreground">还没有会话</p>
                        )}
                        {conversationsQuery.isLoading && (
                          <p className="p-3 text-xs text-muted-foreground">正在加载会话…</p>
                        )}
                        {conversationsQuery.hasNextPage ? (
                          <div className="flex justify-center p-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={conversationsQuery.isFetchingNextPage}
                              onClick={() => void conversationsQuery.fetchNextPage()}
                            >
                              {conversationsQuery.isFetchingNextPage ? '正在加载…' : '加载更多会话'}
                            </Button>
                          </div>
                        ) : items.length > 0 ? (
                          <p className="p-3 text-center text-[11px] text-muted-foreground">
                            共 {items.length} 个会话，已经到底了
                          </p>
                        ) : null}
                      </div>
                      {isNewRoute || isRoot ? (
                        <p className="px-1 text-xs text-muted-foreground">
                          新会话：发出第一条消息后自动建立
                        </p>
                      ) : null}
                    </aside>
                  )}
                </ResizablePanel>

                {/* 分隔条：1px 发丝线，左右各 2px 的命中区（悬停 / 拖动时高亮，键盘也能调） */}
                <ResizableHandle className="bg-surface-3 transition-colors data-[separator=hover]:bg-primary/40 data-[separator=active]:bg-primary" />
              </>
            )}

            {/* 右：对话区（由具体路由渲染：新会话 / 某个会话） */}
            <ResizablePanel minSize="40%" className="h-full" style={{ overflow: 'hidden' }}>
              <div className="relative h-full">
                {!isMobile && sidebarCollapsed ? (
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className="absolute top-3 left-3 z-20 bg-surface-1 shadow-sm"
                    onClick={expandSidebar}
                    title="展开会话列表"
                    aria-label="展开会话列表"
                  >
                    <PanelLeftOpenIcon className="size-3.5" />
                  </Button>
                ) : null}
                {/*
                **这一层不再加内边距**：右栏改成一列通顶白底（`p-4` 会在它上下右都留一圈灰边，
                实测截图就是那圈"间距"）。内边距下沉到会话页的左栏自己身上（见 `chat-conversation`），
                于是右栏可以贴到窗口的上 / 右 / 下边缘。
                `pl-11` 只在会话列表收起时生效：那 44px 是给浮出来的「展开列表」按钮让位的。
              */}
                <section
                  className={cn(
                    'flex h-full min-w-0 flex-col',
                    !isMobile && sidebarCollapsed && 'pl-11',
                  )}
                >
                  {children}
                </section>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>

          {/* 手机端会话列表：独立布局没有管理台侧栏，必须给一个入口 */}
          {isMobile ? (
            <>
              <Sheet open={mobileListOpen} onOpenChange={setMobileListOpen}>
                <SheetContent side="left" className="flex w-[86vw] max-w-sm flex-col p-0">
                  <SheetHeader className="shrink-0 border-b px-4 py-3">
                    <SheetTitle>会话列表</SheetTitle>
                  </SheetHeader>
                  <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
                    <Button
                      size="sm"
                      className="gap-1.5"
                      nativeButton={false}
                      render={
                        <Link href={newConversationPath()} onClick={() => setMobileListOpen(false)}>
                          <PlusIcon className="size-3.5" />
                          新建会话
                        </Link>
                      }
                    />
                    <div className="min-h-0 flex-1 overflow-y-auto">
                      {items.map((conversation) => {
                        const active = pathname === conversationPath(conversation.id)
                        return (
                          <Link
                            key={conversation.id}
                            href={conversationPath(conversation.id)}
                            onClick={() => setMobileListOpen(false)}
                            className={cn(
                              'flex flex-col gap-0.5 rounded-md px-3 py-2 text-sm',
                              active ? 'bg-surface-4' : 'hover:bg-surface-4/60',
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
                        )
                      })}
                      {items.length === 0 && !conversationsQuery.isLoading ? (
                        <p className="p-3 text-xs text-muted-foreground">还没有会话</p>
                      ) : null}
                      {conversationsQuery.hasNextPage ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="mt-2 w-full"
                          disabled={conversationsQuery.isFetchingNextPage}
                          onClick={() => void conversationsQuery.fetchNextPage()}
                        >
                          {conversationsQuery.isFetchingNextPage ? '正在加载…' : '加载更多会话'}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </SheetContent>
              </Sheet>
            </>
          ) : null}

          {/* 重命名弹窗：**不能放进 PanelGroup 里**（分栏库只认 Panel / Separator 作为直接子节点），
          挂在组外面最稳（弹窗本身是 portal，位置不影响视觉） */}
          <ModalForm
            title="重命名会话"
            open={renameDialog.isOpen}
            form={renameForm}
            values={renameDialog.data}
            items={[
              {
                name: 'title',
                label: '会话名',
                hint: '首轮结束后会自动起一个名字；你改过之后就不会再被自动改名覆盖',
                required: true,
              },
            ]}
            onCancel={renameDialog.close}
          />
        </>
      </ChatMobileNavContext.Provider>
      <Dialog open={createWorkspaceOpen} onOpenChange={setCreateWorkspaceOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建工作区</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="ws-name">名称</Label>
            <Input
              id="ws-name"
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              placeholder="例如：数据分析"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateWorkspaceOpen(false)}>
              取消
            </Button>
            <Button onClick={() => createWorkspace.mutate()} disabled={createWorkspace.isPending}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
