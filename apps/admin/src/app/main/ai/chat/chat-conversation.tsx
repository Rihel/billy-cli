'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useChat } from '@ai-sdk/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DefaultChatTransport, isTextUIPart, type UIMessage } from 'ai'
import { Alert, AlertDescription, Badge } from '@repo/ui'
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
import { useServerClient } from '@/lib/server-client'
import { ModelPicker } from './model-picker'
import { MessageRow } from './message-row'
import { toUIMessages } from './history'
import { usageLineText, usageLineTitle } from './format'
import { conversationPath, isNewConversation } from './routes'
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
   * 这是该会话的第几轮 = 已有的助手回复数 + 1（正在跑的这一轮也算第 N 轮）。
   *
   * 口径依据：`toUIMessages` 是**一个根 run = 一条 user + 一条 assistant**，
   * 所以助手消息条数就是已完成的轮数。用户消息中途落库，所以在流跑起来之后这个数就已经 +1 了。
   * 若将来一轮产出多条 assistant 消息，这里要改成按 `data-run` 的 runId 去重计数。
   */
  const turn = messages.filter((message) => message.role === 'assistant').length + 1

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
        {agents.length > 1 && (
          <select
            className="ml-auto h-8 rounded-md border border-border bg-background px-2 text-sm"
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
      </header>

      {errorText || error ? (
        <Alert variant="destructive">
          <AlertDescription>{errorText ?? error?.message}</AlertDescription>
        </Alert>
      ) : null}

      <Conversation className="min-h-0 flex-1 rounded-lg border border-border">
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
