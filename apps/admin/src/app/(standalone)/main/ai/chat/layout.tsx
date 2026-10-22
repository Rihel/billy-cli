'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { usePathname } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from '@tanstack/react-form'
import {
  Button,
  ConfirmAction,
  IconText,
  ModalForm,
  RefreshButton,
  cn,
  toastSuccess,
  useDisclosure,
  useIsMobile,
} from '@repo/ui'
import type { AgentConversationModel } from '@repo/shared'
// 可拖动分栏：`components/ui/*` 属重型基础组件，走子路径按需引入（不进 barrel，带扩展名）
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@repo/ui/components/ui/resizable.tsx'
import { LayoutDashboardIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { Pages } from '@/lib/constants'
import { useServerClient } from '@/lib/server-client'
import { relativeTimeText } from './format'
import { conversationPath, newConversationPath, CHAT_ROOT } from './routes'

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

/** 有会话在跑时的列表轮询间隔（毫秒）：只为把「跑完了」这件事捞回来，不追求实时 */
const RUNNING_POLL_INTERVAL = 5000

export default function ChatLayout({ children }: { children: ReactNode }) {
  const client = useServerClient()
  const pathname = usePathname()
  const router = useRouter()
  const queryClient = useQueryClient()
  const renameDialog = useDisclosure<AgentConversationModel>()
  const conversationsQuery = useQuery({
    queryKey: ['ai', 'conversations'],
    queryFn: () =>
      client.agent.conversation.list({ page: 1, size: 20, includeDeleted: false }),
    // 有会话在跑就轮询：运行状态是**服务端的事实**（根 run 的 pending / running），
    // 前端没有别的地方能知道它什么时候结束 —— 一轮跑完要么标题变了、要么轮数 +1，
    // 靠这次轮询顺手带回来；全都跑完了就停（false），不留一个一直在转的定时器。
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.running) ? RUNNING_POLL_INTERVAL : false,
  })

  /**
   * 改名 / 删除后要刷新的两份缓存：
   * - 侧栏列表（标题、有没有这条）；
   * - 该会话的详情（页头标题、agentKey）。
   */
  const invalidateConversation = (conversationId: string) => {
    void queryClient.invalidateQueries({ queryKey: ['ai', 'conversations'] })
    void queryClient.invalidateQueries({ queryKey: ['ai', 'conversation', conversationId] })
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
      await renameMutation.mutateAsync({ conversationId: target.id, title: value.title })
    },
  })

  const items = conversationsQuery.data?.items ?? []
  const isNewRoute = pathname === newConversationPath()
  const isRoot = pathname === CHAT_ROOT
  // 窄屏（<768px）不放列表栏：分栏需要宽度，手机上两栏都挤成一条
  // （`useIsMobile` 首帧与 SSR 一致返回 false，挂载后再纠正 —— 与 Sidebar 同一套口径）
  const isMobile = useIsMobile()

  return (
    <>
      <ResizablePanelGroup orientation="horizontal" className="h-full w-full">
        {/* 左：会话列表（拖右缘改宽度）。面板自身不滚动 —— 滚动交给列表，否则会出现第二条滚动条 */}
        {isMobile ? null : (
          <>
            <ResizablePanel
              defaultSize={SIDEBAR_WIDTH.default}
              minSize={SIDEBAR_WIDTH.min}
              maxSize={SIDEBAR_WIDTH.max}
              groupResizeBehavior="preserve-pixel-size"
              className="h-full"
              style={{ overflow: 'hidden' }}
            >
              <aside className="flex h-full w-full flex-col gap-2 bg-surface-3 p-3">
                {/* 会话页是独立布局（没有管理台左菜单）——「返回管理台」必须是**看得见的一行**，
                    不能只靠页头那个图标（用户实测找不到）。列表栏在桌面上恒在，放这里最稳 */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="justify-start gap-1.5"
                  nativeButton={false}
                  render={
                    <Link href={Pages.dashboard}>
                      <LayoutDashboardIcon className="size-3.5" />
                      返回管理台
                    </Link>
                  }
                />
                <div className="flex items-center gap-2">
                  {/* 新建 = 跳到 `new` 这个保留段：首轮发出后服务端给会话 id，页面再 replace 成真实地址 */}
                  <Button
                    size="sm"
                    className="gap-1.5"
                    // 渲染成 <a>（可新开标签、可前进后退）时要显式告诉 Base UI 这不是原生 button，
                    // 否则每次进页面都会在控制台报一条"应为原生 <button>"的警告
                    nativeButton={false}
                    render={
                      <Link href={newConversationPath()}>
                        <PlusIcon className="size-3.5" />
                        新建会话
                      </Link>
                    }
                  />
                  <RefreshButton onClick={() => void conversationsQuery.refetch()} />
                </div>
                {/* 列表不画外框也不画行分隔线：选中 / 悬停用底色区分，分隔交给中间那根分隔条 */}
                <div className="flex-1 overflow-auto">
                  {items.map((conversation) => {
                    const active = pathname === conversationPath(conversation.id)
                    return (
                      // 行操作（改名 / 删除）是 `<Link>` 的**兄弟节点**、不是子节点：
                      // 嵌在 Link 里的话，点操作会连带触发跳转 —— `ConfirmAction` 的触发自带 onClick，
                      // 没有留给调用方 `preventDefault` 的口子
                      <div key={conversation.id} className="group relative">
                        <Link
                          href={conversationPath(conversation.id)}
                          aria-current={active ? 'page' : undefined}
                          className={cn(
                            // 右边留出操作区的位置：悬停时按钮浮上来，标题不会被压住
                            'flex w-full flex-col gap-1 rounded-md py-2 pr-14 pl-3 text-left text-sm',
                            'transition-colors hover:bg-surface-4/60',
                            active && 'bg-surface-4',
                          )}
                        >
                          <span className="truncate font-medium">
                            {conversation.title || '(无标题)'}
                          </span>
                          {/* 只显示"几轮"：**不在这里显示 token** ——
                              消耗数字统一在对话框右下角（本轮 `data-run-usage`），
                              列表里再放一个"跨轮累计"会让同一个词（token）指两个不同的东西。
                              累计值在库里（`conversations.total_tokens`），将来要展示就放会话详情，不塞列表行。 */}
                          <span className="flex items-center gap-2 text-xs text-muted-foreground">
                            {/* 正在跑的呼吸灯：外圈扩散 + 内点常亮（纯装饰，语义在文字「运行中」上，
                                读屏才不会被一个空 span 打扰） */}
                            {conversation.running ? (
                              <span className="flex items-center gap-1.5 text-success">
                                <span className="relative flex size-1.5" aria-hidden>
                                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
                                  <span className="relative inline-flex size-1.5 rounded-full bg-success" />
                                </span>
                                运行中
                              </span>
                            ) : null}
                            <span>{conversation.turnCount} 轮</span>
                            {/* 相对时间（用户口径）：列表扫的是"新旧"，不是具体时刻 ——
                                超过一周自动回落成日期，见 `relativeTimeText` */}
                            {relativeTimeText(conversation.updatedAt ?? conversation.createdAt) ? (
                              <span>{relativeTimeText(conversation.updatedAt ?? conversation.createdAt)}</span>
                            ) : null}
                          </span>
                        </Link>
                        {/* 操作：悬停 / 键盘聚焦时出现（与任务列表同一手感） */}
                        <div className="absolute top-1.5 right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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
                  {items.length === 0 && !conversationsQuery.isLoading && (
                    <p className="p-3 text-xs text-muted-foreground">还没有会话</p>
                  )}
                  {conversationsQuery.isLoading && (
                    <p className="p-3 text-xs text-muted-foreground">正在加载会话…</p>
                  )}
                </div>
                {isNewRoute || isRoot ? (
                  <p className="px-1 text-xs text-muted-foreground">新会话：发出第一条消息后自动建立</p>
                ) : null}
              </aside>
            </ResizablePanel>

            {/* 分隔条：1px 发丝线，左右各 2px 的命中区（悬停 / 拖动时高亮，键盘也能调） */}
            <ResizableHandle className="bg-surface-3 transition-colors data-[separator=hover]:bg-primary/40 data-[separator=active]:bg-primary" />
          </>
        )}

          {/* 右：对话区（由具体路由渲染：新会话 / 某个会话） */}
          <ResizablePanel minSize="40%" className="h-full" style={{ overflow: 'hidden' }}>
            <section className="flex h-full min-w-0 flex-col gap-3 p-4">{children}</section>
          </ResizablePanel>
      </ResizablePanelGroup>

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
  )
}
