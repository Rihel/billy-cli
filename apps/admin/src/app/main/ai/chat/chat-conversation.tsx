'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useChat } from '@ai-sdk/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DefaultChatTransport, isTextUIPart, type UIMessage } from 'ai'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@repo/ui'
// ai-elements 组件**走子路径**（不进 barrel：体积大、按需引入，见 docs/design/ai-agent.md §1）
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@repo/ui/components/ai-elements/conversation.tsx'
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@repo/ui/components/ai-elements/prompt-input.tsx'
import { ScrollTextIcon } from 'lucide-react'
import { useServerClient } from '@/lib/server-client'
import { ModelPicker } from './model-picker'
import { MessageRow } from './message-row'
import { toUIMessages } from './history'
import { usageLineText, usageLineTitle } from './format'
import { conversationPath, isNewConversation } from './routes'
import type { AgentConversationModel } from '@repo/shared'
import type { AppPageQueryResponse } from '@repo/shared'
import { lastRunUsage, loadWholeRuns, loadWholeTimeline } from './data'

/**
 * 一个会话的对话区（`/main/ai/chat/[conversationId]` 渲染它）。
 *
 * 三条数据链路（各管一段，互不冒充）：
 * 1. **流**（`useChat` + `/agent/chat/stream`）：文本 / 推理 / 工具入参出参 / 步骤 / 子助手明细，
 *    边跑边显示；断线（刷新 / 切换网络）由 `resume: true` 自动接回去（服务端按 offset 补发）；
 * 2. **库**（`/agent/timeline/list` + `/agent/run/list`）：刷新后重建历史；子助手的完整过程按需拉取；
 * 3. **身份**（流里的第一个 `data-run` 块）：拿到本轮 `runId` —— **停止与重连都只认它**。
 *
 * 两个必须记住的坑（与设计文档 §5.6 一致）：
 * - `useChat().stop()` 只断开本地连接，**不会取消服务端生成** → 停止必须再调 `/agent/run/stop`；
 * - 服务端错误默认不下发细节 → 这里用 `onError` 把真实原因显示给用户。
 *
 * 路由化之后的新口径（"每个会话一个地址"）：
 * - `conversationId` 由**路由参数**给出（`new` = 还没建会话）；
 * - 新会话首轮发出后，流里的 `data-run` 带回真实会话 id → `router.replace` 换成真实地址
 *   （**不重挂载**：`replace` 到同一个动态路由的另一个参数不会重建组件，正在流的这一轮不中断）；
 * - 切换会话 = 换地址：组件按 key 重挂载，历史由 `useEffect` 从库里重建。
 */
export function ChatConversation({ conversationId }: { conversationId: string }) {
  const client = useServerClient()
  const router = useRouter()
  const queryClient = useQueryClient()
  const isNew = isNewConversation(conversationId)

  const [modelId, setModelId] = useState<string>()
  /** 本轮改选的 agent（会话自带的 agentKey 由详情给出；这里是"覆盖值"，null 表示未覆盖） */
  const [agentKeyOverride, setAgentKeyOverride] = useState<string | null>(null)
  const [runId, setRunId] = useState<string>()
  const [errorText, setErrorText] = useState<string>()
  const [loading, setLoading] = useState(!isNew)
  // 停止按钮要用它；放在 ref 里避免每次拿到 runId 就重建 transport
  const runIdRef = useRef<string | undefined>(undefined)
  /**
   * 当前**真实的**会话 id（新会话在首轮发出前是 `undefined`）。
   *
   * 与路由参数分开：新会话时路由是 `.../new`，而发请求要带的是服务端给的 id（还是 undefined）。
   */
  const activeConversationIdRef = useRef<string | undefined>(isNew ? undefined : conversationId)

  const agentsQuery = useQuery({
    queryKey: ['ai', 'agents'],
    queryFn: () => client.agent.list(),
  })
  /** 已有会话的详情（拿 agentKey；顺带让侧栏列表与详情口径一致） */
  const conversationQuery = useQuery({
    queryKey: ['ai', 'conversation', conversationId],
    queryFn: () => client.agent.conversation.detail({ conversationId }),
    enabled: !isNew,
  })
  const agentKey = agentKeyOverride ?? conversationQuery.data?.agentKey

  /**
   * transport 要**稳定引用**（每次渲染新建会让 useChat 反复重建内部状态）。
   * 它只依赖 client，会话 id / agentKey 走 ref 取最新值。
   */
  const agentKeyRef = useRef<string | undefined>(undefined)
  const modelIdRef = useRef<string | undefined>(undefined)
  agentKeyRef.current = agentKey ?? undefined
  modelIdRef.current = modelId

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: client.agent.chatStreamUrl(),
        // 鉴权头与普通请求同一套（未登录返回 {}，后端会回 401）
        headers: async () => client.agent.authHeaders(),
        /**
         * 我们的建流接口收的是**业务入参**（`{ conversationId?, agentKey?, message }`），
         * 不是 AI SDK 默认的 `{ messages, id, trigger }` —— 在这里做一次转换。
         */
        prepareSendMessagesRequest: ({ messages }) => {
          const last = messages.at(-1)
          const message = (last?.parts ?? [])
            .filter((part) => isTextUIPart(part))
            .map((part) => part.text)
            .join('\n')
            .trim()
          return {
            body: {
              // 已有会话就带上；新会话不带（服务端会建一个，并从流里把 id 回给我们）
              ...(activeConversationIdRef.current
                ? { conversationId: activeConversationIdRef.current }
                : {}),
              ...(agentKeyRef.current ? { agentKey: agentKeyRef.current } : {}),
              // 这一轮用哪个模型（后台配过且启用的）：服务端会校验，不可用直接报错，**不静默回落**
              ...(modelIdRef.current ? { modelId: modelIdRef.current } : {}),
              message,
            },
          }
        },
        /**
         * 断线重连：**一定要指向一个允许 GET 的地址**。
         *
         * AI SDK 的 `reconnectToStream` 固定发 GET，而建流端点是 POST-only ——
         * 这里如果退回建流地址，浏览器就会对 `POST /agent/chat/stream` 发一次 GET，**404**
         * （踩过的坑）。所以用"按登录用户找当前进行中那一轮"的端点：
         * 有在跑的流就补发接回，没有就 204，SDK 静默收尾。
         */
        prepareReconnectToStreamRequest: () => ({
          api: client.agent.currentRunStreamUrl(),
        }),
      }),
    [client],
  )

  const { messages, sendMessage, status, stop, setMessages, error, clearError } = useChat({
    // 一个会话一个 Chat 实例：带上会话 id，切换会话时 SDK 内部状态也隔离
    id: `billy-ai-chat-${conversationId}`,
    transport,
    // 挂载即尝试重连（React 19 StrictMode 下有并发去重，别自己在 useEffect 里调 resumeStream）
    resume: true,
    experimental_throttle: 60,
    onData: (part) => {
      /**
       * 首轮结束时的**自动命名**：服务端在收尾阶段把新标题推下来（`data-conversation-title`）。
       *
       * 为什么要推：命名发生在服务端收尾，前端那份"会话列表 / 会话详情"缓存不会自己知道 ——
       * 就地改缓存（而不是整份重拉）才能让侧栏与页头**当场**换名字，且不多一次请求。
       * 服务端没推（没改名 / 起名失败）时什么都不做：前端本来就显示着兜底标题。
       */
      if (part.type === 'data-conversation-title') {
        const data = part.data as { conversationId?: string; title?: string }
        const targetId = data.conversationId ?? activeConversationIdRef.current
        if (!targetId || !data.title) return
        queryClient.setQueryData<AppPageQueryResponse<AgentConversationModel>>(
          ['ai', 'conversations'],
          (current) =>
            current
              ? {
                  ...current,
                  items: current.items.map((item) =>
                    item.id === targetId ? { ...item, title: data.title! } : item,
                  ),
                }
              : current,
        )
        queryClient.setQueryData<AgentConversationModel>(
          ['ai', 'conversation', targetId],
          (current) => (current ? { ...current, title: data.title! } : current),
        )
        return
      }

      // 本轮身份：记住 runId 与（新建会话时的）真实会话 id
      if (part.type !== 'data-run') return
      const data = part.data as { runId?: string; conversationId?: string }
      if (data.runId) {
        runIdRef.current = data.runId
        setRunId(data.runId)
      }
      if (data.conversationId && data.conversationId !== activeConversationIdRef.current) {
        activeConversationIdRef.current = data.conversationId
        // 侧栏列表要立刻出现这条新会话（同一个 QueryClient，不用 prop 传递）
        void queryClient.invalidateQueries({ queryKey: ['ai', 'conversations'] })
        if (isNew) {
          // 换地址但**不重挂载**（同一动态路由换参数），正在流的这一轮不中断
          router.replace(conversationPath(data.conversationId))
        }
      }
    },
    onError: (chatError) => setErrorText(chatError.message),
  })

  const streaming = status === 'streaming' || status === 'submitted'

  /**
   * 一轮**结束后对账**：把侧栏列表与该会话详情失效重取。
   *
   * 为什么要这一步：这一轮在服务端改了三样前端看不到的东西 ——
   * **轮数 +1**、token 累计、以及首轮结束时的**自动命名**（标题）。
   * 标题另有 `data-conversation-title` 实时推送（见 `onData`），但轮数 / 累计 / 列表排序
   * 只在库里变，不重取就一直显示旧值（"跑完还是 0 轮"这种）。两个小请求，换一次干净的对账。
   *
   * 只在**从流式回到空闲**那一次触发（用 ref 记"刚才确实在跑"），不是每次渲染都拉。
   */
  const wasStreaming = useRef(false)
  useEffect(() => {
    if (streaming) {
      wasStreaming.current = true
      return
    }
    if (!wasStreaming.current) return
    wasStreaming.current = false
    void queryClient.invalidateQueries({ queryKey: ['ai', 'conversations'] })
    const detailId = activeConversationIdRef.current ?? (isNew ? undefined : conversationId)
    if (detailId) {
      void queryClient.invalidateQueries({ queryKey: ['ai', 'conversation', detailId] })
    }
  }, [streaming, isNew, conversationId, queryClient])

  /**
   * 从库里重建本会话的历史（刷新 / 直接用地址打开 / 从侧栏点进来都走这里）。
   *
   * 三个必须做到的点：
   * 1. **翻页取全**（单页上限 100，见 `TIMELINE_PAGE_SIZE`）；
   * 2. **失败必须显示**：早先 `Promise.all` 抛错后既不提示也不回显，页面看起来就是"点了没反应"
   *    （真实原因是 400 被吞掉），排障成本极高；
   * 3. **新会话不拉**（`new` 只是占位，还没有会话 id）。
   */
  useEffect(() => {
    if (isNew) {
      setMessages([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const [items, runs] = await Promise.all([
          loadWholeTimeline(client, conversationId),
          loadWholeRuns(client, conversationId),
        ])
        if (cancelled) return
        setMessages(toUIMessages(items, runs))
      } catch (loadError) {
        if (cancelled) return
        setErrorText(
          `会话历史加载失败：${loadError instanceof Error ? loadError.message : String(loadError)}`,
        )
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, conversationId, isNew, setMessages])

  const agents = agentsQuery.data?.agents ?? []
  const activeAgent = agents.find(
    (agent) => agent.key === (agentKey ?? agentsQuery.data?.defaultAgentKey),
  )
  const usage = lastRunUsage(messages)
  /**
   * 这是该会话的第几轮 = 助手消息条数（至少 1）。
   *
   * 口径依据：`toUIMessages` 是**一个根 run = 一条 user + 一条 assistant**，
   * 而 `useChat` 的 `messages` 里**已经包含正在流的那条助手消息** ——
   * 所以"+1"会多算一轮（踩过：第一轮答完就显示"2 轮"）。用 max(1, n) 兜住"还没开始/刚发出"的瞬间。
   * 若将来一轮产出多条 assistant 消息，这里要改成按 `data-run` 的 runId 去重计数。
   */
  const turn = Math.max(1, messages.filter((message) => message.role === 'assistant').length)

  /**
   * 用户主动停止。
   *
   * **必须两条都做**：`stop()` 只断本地连接，生成还在服务端跑（官方文档明说）——
   * 真正取消是 `/agent/run/stop`（跨副本时服务端自己广播，前端不关心）。
   */
  const stopRun = async () => {
    const target = runIdRef.current
    stop()
    if (!target) return
    try {
      await client.agent.stopRun({ runId: target })
    } catch (stopError) {
      setErrorText(stopError instanceof Error ? stopError.message : String(stopError))
    }
  }

  return (
    <>
      <header className="flex items-center gap-2">
        <h1 className="font-heading text-lg font-semibold">
          {isNew ? '新会话' : conversationQuery.data?.title || '会话'}
        </h1>
        {activeAgent ? (
          <Badge variant="secondary">{activeAgent.name}</Badge>
        ) : (
          <Badge variant="outline">未配置</Badge>
        )}
        {runId ? (
          <span className="font-mono text-xs text-muted-foreground">run {runId}</span>
        ) : null}
        {status !== 'ready' ? (
          <Badge variant={status === 'error' ? 'destructive' : 'outline'}>{status}</Badge>
        ) : null}
        {/* 右侧：查看系统指令 + 换 agent */}
        <div className="ml-auto flex items-center gap-2">
          <SystemInstructions
            client={client}
            agentKey={agentKey ?? agentsQuery.data?.defaultAgentKey}
          />
          {agents.length > 1 && (
            <select
              className="h-8 rounded-md border border-border bg-background px-2 text-sm"
              value={agentKey ?? agentsQuery.data?.defaultAgentKey ?? ''}
              onChange={(event) => {
                // 改选只对"接下来这一轮"生效（服务端每轮从入参取 agentKey）
                setAgentKeyOverride(event.target.value)
              }}
              disabled={streaming}
            >
              {agents.map((agent) => (
                <option key={agent.key} value={agent.key}>
                  {agent.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </header>

      {errorText || error ? (
        <Alert variant="destructive">
          <AlertDescription>{errorText ?? error?.message}</AlertDescription>
        </Alert>
      ) : null}

      {/* 消息列表不画外框：整块与页面同底，气泡 / 工具卡自己带层次，边框只会把界面切成一块块 */}
      <Conversation className="min-h-0 flex-1">
        <ConversationContent>
          {loading ? (
            <p className="p-3 text-xs text-muted-foreground">正在加载会话历史…</p>
          ) : messages.length === 0 ? (
            <ConversationEmptyState
              title={isNew ? '问点什么' : '这个会话还没有内容'}
              description="试着问「最近有哪些待办」，或让它「分步整理一份待办周报」——它会自己规划、必要时造一个子助手"
            />
          ) : (
            messages.map((message) => (
              <MessageRow
                key={message.id}
                message={message}
                streaming={streaming}
                client={client}
                conversationId={isNew ? undefined : conversationId}
              />
            ))
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <PromptInput
        onSubmit={({ text }) => {
          const content = text.trim()
          if (!content || streaming) return
          setErrorText(undefined)
          clearError()
          void sendMessage({ text: content })
        }}
      >
        <PromptInputBody>
          <PromptInputTextarea placeholder="说说你想做什么…（Enter 发送，Shift+Enter 换行）" />
        </PromptInputBody>
        {/* 左下角：本轮用哪个模型；右下角：本轮统计 + 发送/停止 */}
        <PromptInputFooter className="gap-2">
          <PromptInputTools>
            <ModelPicker value={modelId} onChange={setModelId} disabled={streaming} />
          </PromptInputTools>
          <div className="flex min-w-0 items-center gap-2">
            <RunUsageInline usage={usage} turn={turn} />
            {/* 流式中这个按钮就是"停止"（内部按 status 换成方块图标），onStop 里做真正的取消 */}
            <PromptInputSubmit status={status} onStop={() => void stopRun()} />
          </div>
        </PromptInputFooter>
      </PromptInput>
    </>
  )
}

/**
 * 「查看系统指令」：把**当前 agent 的系统提示词原文**显示出来（只读弹窗）。
 *
 * 数据源是 `POST /agent/instructions`（直接回装配期渲染好的那份，服务端不另存副本）：
 * 于是这里看到的就是真正挂在这个 agent 上的提示词 —— 页面与运行时不可能各说一套。
 * 会话首轮末尾还会追加「运行环境」片段（操作系统 + 当前时间，见设计文档 §3.15.4），
 * 那段是**按轮拼上去的**、不在静态指令里，弹窗底部如实说明。
 *
 * 打开时才请求（`enabled: open`）：没点开就不该多一次往返，更不该让"看一眼"变成每次进页面都拉。
 */
function SystemInstructions({
  client,
  agentKey,
}: {
  client: ReturnType<typeof useServerClient>
  agentKey?: string
}) {
  const [open, setOpen] = useState(false)
  const query = useQuery({
    queryKey: ['ai', 'instructions', agentKey ?? 'default'],
    queryFn: () => client.agent.instructions(agentKey ? { agentKey } : {}),
    enabled: open,
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
        <ScrollTextIcon className="size-3.5" />
        系统指令
      </Button>
      <DialogContent className="max-h-[80vh] gap-3 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            系统指令{query.data ? ` · ${query.data.name}` : ''}
          </DialogTitle>
          <DialogDescription>
            这个 agent 现在被怎么要求（可用工具、通用约定、角色约定）。会话第一轮还会在末尾
            追加一段「运行环境」（操作系统 + 当前时间），需要精确时间时它会用 `run-command` 自己取。
          </DialogDescription>
        </DialogHeader>
        {query.isLoading ? (
          <p className="text-xs text-muted-foreground">正在加载系统指令…</p>
        ) : query.isError ? (
          <p className="text-xs text-destructive">
            加载失败：{query.error instanceof Error ? query.error.message : String(query.error)}
          </p>
        ) : (
          <pre className="max-h-[55vh] overflow-auto rounded-md bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {query.data?.instructions ?? ''}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * 输入框**右下角**的一轮统计：`N 轮 M 步，输入 X，输出 Y，缓存命中 Z`。
 *
 * 文案拼装在 `format.ts` 的 `usageLineText`（纯函数、有单测）；这里只管排版：
 * 行内短（一眼看量级）、悬停全（精确值对账）。
 * 轮 / 步的口径：轮 = 该会话第几轮（页面算好传进来），步 = 这一轮里模型被调了几次。
 */
function RunUsageInline({
  usage,
  turn,
}: {
  usage: Record<string, unknown> | null
  turn: number
}) {
  const text = usageLineText(usage, turn)
  if (!text) return null
  return (
    <span className="truncate text-xs text-muted-foreground" title={usageLineTitle(usage, turn)}>
      {text}
    </span>
  )
}
