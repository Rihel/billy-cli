'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DefaultChatTransport,
  getToolName,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
  type UIMessage,
} from 'ai'
import { Alert, AlertDescription, Badge, Button, RefreshButton, cn } from '@repo/ui'
// ai-elements 组件**走子路径**（不进 barrel：体积大、按需引入，见 docs/design/ai-agent.md §1）
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@repo/ui/components/ai-elements/conversation.tsx'
import {
  Message,
  MessageContent,
  MessageResponse,
} from '@repo/ui/components/ai-elements/message.tsx'
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '@repo/ui/components/ai-elements/reasoning.tsx'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@repo/ui/components/ai-elements/tool.tsx'
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from '@repo/ui/components/ai-elements/prompt-input.tsx'
import type { AgentConversationModel } from '@repo/shared'
import { useServerClient } from '@/lib/server-client'
import { SubAgentPanel, type SubAgentDelta, type SubAgentState } from './sub-agent-panel'
import { toSubAgentDetail, toUIMessages } from './history'

/**
 * AI 会话页（`/ai/chat`）—— 需求 E 的落点：**AI 跑的每个细节都要看得见**。
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
 */
const PAGE_SIZE = 20

export default function AiChatPage() {
  const client = useServerClient()
  const queryClient = useQueryClient()
  const [conversationId, setConversationId] = useState<string>()
  const [agentKey, setAgentKey] = useState<string>()
  const [runId, setRunId] = useState<string>()
  const [errorText, setErrorText] = useState<string>()
  // 停止按钮要用它；放在 ref 里避免每次拿到 runId 就重建 transport
  const runIdRef = useRef<string | undefined>(undefined)

  const conversationsQuery = useQuery({
    queryKey: ['ai', 'conversations'],
    queryFn: () => client.agent.conversation.list({ page: 1, size: PAGE_SIZE, includeDeleted: false }),
  })
  const agentsQuery = useQuery({
    queryKey: ['ai', 'agents'],
    queryFn: () => client.agent.list(),
  })

  /**
   * transport 要**稳定引用**（每次渲染新建会让 useChat 反复重建内部状态）。
   * 它只依赖 client，会话 id / agentKey 走 `body` 的闭包读取（用 ref 取最新值）。
   */
  const conversationIdRef = useRef<string | undefined>(undefined)
  const agentKeyRef = useRef<string | undefined>(undefined)
  conversationIdRef.current = conversationId
  agentKeyRef.current = agentKey

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
              ...(conversationIdRef.current
                ? { conversationId: conversationIdRef.current }
                : {}),
              ...(agentKeyRef.current ? { agentKey: agentKeyRef.current } : {}),
              message,
            },
          }
        },
        /**
         * 断线重连：**一定要指向一个允许 GET 的地址**。
         *
         * AI SDK 的 `reconnectToStream` 固定发 GET，而建流端点是 POST-only ——
         * 这里如果退回建流地址，浏览器就会对 `POST /agent/chat/stream` 发一次 GET，**404**
         * （踩过的坑）。所以无 runId 时用"按登录用户找当前进行中那一轮"的端点：
         * 有在跑的流就补发接回，没有就 204，SDK 静默收尾。
         */
        prepareReconnectToStreamRequest: () => ({
          api: client.agent.currentRunStreamUrl(),
        }),
      }),
    [client],
  )

  const { messages, sendMessage, status, stop, setMessages, error, clearError } =
    useChat({
      id: 'billy-ai-chat',
      transport,
      // 挂载即尝试重连（React 19 StrictMode 下有并发去重，别自己在 useEffect 里调 resumeStream）
      resume: true,
      experimental_throttle: 60,
      onData: (part) => {
        // 本轮身份：记住 runId 与（新建会话时的）conversationId
        if (part.type !== 'data-run') return
        const data = part.data as { runId?: string; conversationId?: string }
        if (data.runId) {
          runIdRef.current = data.runId
          setRunId(data.runId)
        }
        if (data.conversationId && data.conversationId !== conversationIdRef.current) {
          conversationIdRef.current = data.conversationId
          setConversationId(data.conversationId)
          void queryClient.invalidateQueries({ queryKey: ['ai', 'conversations'] })
        }
      },
      onError: (chatError) => setErrorText(chatError.message),
    })

  const streaming = status === 'streaming' || status === 'submitted'

  /** 切换会话：历史从库里重建（刷新后也一样），并清掉上一轮的错误 */
  const openConversation = useCallback(
    async (conversation: AgentConversationModel) => {
      clearError()
      setErrorText(undefined)
      setRunId(undefined)
      runIdRef.current = undefined
      setConversationId(conversation.id)
      conversationIdRef.current = conversation.id
      setAgentKey(conversation.agentKey)
      const [timeline, runs] = await Promise.all([
        client.agent.timeline.list({ conversationId: conversation.id, page: 1, size: 500 }),
        client.agent.run.list({ conversationId: conversation.id, page: 1, size: 100 }),
      ])
      setMessages(toUIMessages(timeline.items, runs.items))
    },
    [clearError, client, setMessages],
  )

  const newConversation = () => {
    clearError()
    setErrorText(undefined)
    setRunId(undefined)
    runIdRef.current = undefined
    setConversationId(undefined)
    conversationIdRef.current = undefined
    setMessages([])
  }

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

  const agents = agentsQuery.data?.agents ?? []
  const activeAgent = agents.find((agent) => agent.key === (agentKey ?? agentsQuery.data?.defaultAgentKey))

  return (
    <div className="mx-auto flex h-[calc(100vh-4rem)] w-full max-w-6xl gap-4 px-4 py-4">
      {/* 左：会话列表（库里的真相） */}
      <aside className="hidden w-64 shrink-0 flex-col gap-2 md:flex">
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={newConversation}>
            新建会话
          </Button>
          <RefreshButton onClick={() => void conversationsQuery.refetch()} />
        </div>
        <div className="flex-1 overflow-auto rounded-lg border border-border">
          {(conversationsQuery.data?.items ?? []).map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              onClick={() => void openConversation(conversation)}
              className={cn(
                'flex w-full flex-col gap-1 border-b border-border px-3 py-2 text-left text-sm last:border-b-0',
                'transition-colors hover:bg-muted/50',
                conversationId === conversation.id && 'bg-muted',
              )}
            >
              <span className="truncate font-medium">
                {conversation.title || '(无标题)'}
              </span>
              <span className="text-xs text-muted-foreground">
                {conversation.turnCount} 轮 · {conversation.totalTokens} token
              </span>
            </button>
          ))}
          {conversationsQuery.data?.items.length === 0 && (
            <p className="p-3 text-xs text-muted-foreground">还没有会话</p>
          )}
        </div>
      </aside>

      {/* 右：对话区 */}
      <section className="flex min-w-0 flex-1 flex-col gap-3">
        <header className="flex items-center gap-2">
          <h1 className="font-heading text-lg font-semibold">AI 助手</h1>
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
          <div className="ml-auto flex items-center gap-2">
            {agents.length > 1 && (
              <select
                className="h-8 rounded-md border border-border bg-background px-2 text-sm"
                value={agentKey ?? agentsQuery.data?.defaultAgentKey ?? ''}
                onChange={(event) => setAgentKey(event.target.value)}
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

        <Conversation className="min-h-0 flex-1 rounded-lg border border-border">
          <ConversationContent>
            {messages.length === 0 ? (
              <ConversationEmptyState
                title="问点什么"
                description="试着问「最近有哪些待办」，或让它「分步整理一份待办周报」——它会自己规划、必要时造一个子助手"
              />
            ) : (
              messages.map((message) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  streaming={streaming}
                  client={client}
                  conversationId={conversationId}
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
          <PromptInputFooter className="justify-end">
            {/* 流式中这个按钮就是"停止"（内部按 status 换成方块图标），onStop 里做真正的取消 */}
            <PromptInputSubmit status={status} onStop={() => void stopRun()} />
          </PromptInputFooter>
        </PromptInput>
      </section>
    </div>
  )
}

/**
 * 一条消息：把 parts 铺成"看得见的细节"。
 *
 * 顺序即 parts 顺序（服务端就是这么流出来的），每类 part 用对应的 AI Elements 组件：
 * 文本 → `MessageResponse`（流式 Markdown）、推理 → `Reasoning`、
 * 工具 → `Tool*`（七态徽标 + 入参出参）、子助手 → `SubAgentPanel`（嵌套卡片）。
 */
function MessageRow({
  message,
  streaming,
  client,
  conversationId,
}: {
  message: UIMessage
  streaming: boolean
  client: ReturnType<typeof useServerClient>
  conversationId?: string
}) {
  const isUser = message.role === 'user'

  // 子助手：状态块按 id 归并，增量块按顺序累计（两类块在服务端就是分开写的）
  const subAgents = new Map<string, SubAgentState>()
  const subAgentDeltas = new Map<string, SubAgentDelta[]>()
  for (const part of message.parts) {
    if (part.type === 'data-sub-agent') {
      const data = part.data as Record<string, unknown>
      const runId = String(data.runId ?? part.id ?? '')
      subAgents.set(runId, { ...(data as object), runId } as SubAgentState)
    } else if (part.type === 'data-sub-agent-delta') {
      const data = part.data as { runId?: string; kind?: 'text' | 'reasoning'; text?: string }
      const runId = String(data.runId ?? '')
      const list = subAgentDeltas.get(runId) ?? []
      list.push({ kind: data.kind ?? 'text', text: data.text ?? '' })
      subAgentDeltas.set(runId, list)
    }
  }
  // 历史模式下前端只有结论：给面板一个"按需拉子 run 时间线"的回调
  for (const [runId, state] of subAgents) {
    // 只有"已经有结论"的子助手才值得去拉明细（进行中的正在流，别重复请求）
    if (conversationId && state.status && state.status !== 'running') {
      state.loadDetail = async () => {
        const page = await client.agent.timeline.list({
          conversationId,
          runId,
          page: 1,
          size: 200,
        })
        return toSubAgentDetail(page.items)
      }
    }
  }

  return (
    <Message from={message.role}>
      <MessageContent>
        {message.parts.map((part, index) => {
          if (isTextUIPart(part)) {
            return isUser ? (
              <p key={index} className="whitespace-pre-wrap">
                {part.text}
              </p>
            ) : (
              <MessageResponse key={index}>{part.text}</MessageResponse>
            )
          }
          if (isReasoningUIPart(part)) {
            return (
              <Reasoning
                key={index}
                isStreaming={streaming && part.state === 'streaming'}
              >
                <ReasoningTrigger />
                <ReasoningContent>{part.text}</ReasoningContent>
              </Reasoning>
            )
          }
          if (isToolUIPart(part)) {
            const toolName = getToolName(part)
            const isPlan = toolName === 'write-plan'
            return (
              <Tool key={index} defaultOpen={isPlan}>
                <ToolHeader
                  type="dynamic-tool"
                  state={part.state}
                  toolName={toolName}
                />
                <ToolContent>
                  <ToolInput input={part.input} />
                  {part.state === 'output-available' && (
                    <ToolOutput output={part.output} errorText={undefined} />
                  )}
                  {part.state === 'output-error' && (
                    <ToolOutput output={undefined} errorText={part.errorText} />
                  )}
                </ToolContent>
              </Tool>
            )
          }
          if (part.type === 'data-sub-agent') {
            const data = part.data as Record<string, unknown>
            const runId = String(data.runId ?? part.id ?? '')
            const state = subAgents.get(runId)
            if (!state) return null
            return (
              <SubAgentPanel
                key={`${runId}-${index}`}
                agent={state}
                deltas={subAgentDeltas.get(runId) ?? []}
              />
            )
          }
          if (part.type === 'data-sub-agent-delta') {
            // 增量块本身不渲染（已并入上面的面板），避免重复显示
            return null
          }
          if (part.type === 'data-run') {
            return null
          }
          // 未知 part 类型显式露出来：协议演进时"看得见"比"静默丢掉"好排障
          return (
            <span key={index} className="text-xs text-muted-foreground">
              <Badge variant="outline">{part.type}</Badge>
            </span>
          )
        })}
        {message.parts.length === 0 ? (
          <span className="text-xs text-muted-foreground">（空消息）</span>
        ) : null}
      </MessageContent>
    </Message>
  )
}
