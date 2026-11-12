'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useChat } from '@ai-sdk/react'
import { useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import {
  isTextUIPart,
  parseJsonEventStream,
  readUIMessageStream,
  uiMessageChunkSchema,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  DictSelect,
  IconText,
  PromptInputAttachmentsBar,
  SegmentedControl,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  toastError,
  toastSuccess,
  useImageLightbox,
  useIsMobile,
} from '@repo/ui'
import type { PromptAttachmentItem } from '@repo/ui'
// 可拖动分栏：`components/ui/*` 属重型基础组件，走子路径按需引入（不进 barrel，带扩展名）
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@repo/ui/components/ui/resizable.tsx'
// ai-elements 组件**走子路径**（不进 barrel：体积大、按需引入，见 docs/design/ai-agent.md §1）
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@repo/ui/components/ai-elements/conversation.tsx'
import {
  PromptInput,
  PromptInputAttachmentButton,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@repo/ui/components/ai-elements/prompt-input.tsx'
import { BotIcon, CopyIcon, LayoutDashboardIcon, MessagesSquareIcon, PanelRightIcon } from 'lucide-react'
import { Pages } from '@/lib/constants'
import { useServerClient } from '@/lib/server-client'
import { useChatMobileNav } from './mobile-nav-context'
import { markAdoptedConversation, NEW_CONVERSATION_SLUG } from './routes'
import { ModelPicker } from './model-picker'
import { ChatMessage } from './message-row'
import {
  useActiveSubAgentName,
  useChatMessages,
  useChatSessionStore,
  useHasActiveSubAgent,
} from './chat-session'
import { ChatTransport } from './chat-transport'
import { toUIMessages } from './history'
import { conversationPlanOfPlans } from './plan-panel'
import { ConversationRightPanel, type RightPanelTab } from './right-panel'
import { RunActivity } from './run-activity'
import { PlanSummaryCard } from './plan-summary-card'
import {
  QuestionCard,
  type AnswerQuestionsInput,
  type SuspendedPartData,
} from './question-card'
// 自动展开的判据与工具卡共用同一份（`shouldAutoOpen`：有东西可看 + 用户没动过手）——
// 同一套纪律只写一次，避免两处各有一套"用户手动优先"的实现漂移
import { shouldAutoOpen } from './tool-card'
import { copyText } from '@/lib/clipboard'
import { parseChatError, usageLineText, usageLineTitle } from './format'
import { conversationPath, isNewConversation } from './routes'
import { ATTACHMENT_ACCEPT, formatFileSize } from './attachment-utils'
import { rejectedText, scanFiles, useAttachmentsUpload } from './use-attachments-upload'
import { currentModelModalities, useAvailableModels } from './use-available-models'
import type { AgentConversationModel, ChatAttachmentModel } from '@repo/shared'
import type { AppPageQueryResponse } from '@repo/shared'
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_COUNT,
  ChatAttachmentSchema,
} from '@repo/shared'
import { z } from 'zod'
import { lastRunUsage, loadWholeRuns, loadWholeTimeline } from './data'
import { markSuspendedAnswered, pinResumeMessageId } from './resume-answer'

/** 附件上限的展示文案（与 `AgentChatSchema` 的常量同源，改一处就够） */
const ATTACHMENT_LIMIT_TEXT = `单个附件不超过 ${formatFileSize(CHAT_ATTACHMENT_MAX_BYTES)}`

/**
 * 从 `sendMessage` 传来的 `requestMetadata` 里取出附件元数据。
 *
 * 用 zod **真校验**而不是 `as` 断言：这份数据会被直接塞进请求体 ——
 * 形状不认识（或某一条不合格）就当作没有附件，而不是把半成品发给服务端。
 * `metadata` 是跨层的弱约定（类型系统管不到），所以这里必须自己把住。
 */
const attachmentMetadataOf = (metadata: unknown): ChatAttachmentModel[] => {
  if (!metadata || typeof metadata !== 'object') return []
  const parsed = z
    .array(ChatAttachmentSchema)
    .max(CHAT_ATTACHMENT_MAX_COUNT)
    .safeParse((metadata as { attachments?: unknown }).attachments)
  return parsed.success ? parsed.data : []
}

/**
 * 右栏开关的持久化 key：换会话 / 刷新都记住上次的选择。
 *
 * 为什么存在浏览器而不是每个会话一份：右栏是"看记录 / 看提示词"的工具，
 * 打开了就该一直开着；而且新会话首轮发出后地址会 `replace`（组件重挂载），
 * 状态放内存里会被这一次重挂载清掉。
 */
const PANEL_OPEN_STORAGE_KEY = 'ai-chat-right-panel-open'

/** 右栏宽度：默认 40%，最小 260px、最大 55%；窗口变宽时按比例吸收 */
const PANEL_WIDTH = { default: '40%', min: 260, max: '55%' } as const

/**
 * 选中的模型按会话记在浏览器里（`ai-chat-model:<会话 id>`，新会话用 `new` 这一段）。
 *
 * 为什么不能只放组件 state（**实测踩过**）：新会话首轮发出后，地址从 `new` replace 成真实 id，
 * 这一次跳转会**重挂载整棵对话区** —— Next 在动态段换参数时要重新取 RSC，页面被卸载再挂回来
 * （对着 DOM 实测：textarea 元素被换掉、`loading` 又变回 true）。而 `runs` 里那一轮的 `model`
 * 仍是选中的那个：数据没错，**只有界面被重置**，于是表现成"选了非默认模型，一发消息就回到默认"。
 * 存进浏览器，重挂载 / 刷新 / 从侧栏点回来都不会丢。
 *
 * 两条口径：
 * - `new` 那一份是"下一个新会话的待用选择" —— 新建会话沿用上次选的模型；
 * - 模型被删 / 停用后由组件里的 effect 归零（见"存的选择已不在清单里"那段）。
 */
const MODEL_STORAGE_PREFIX = 'ai-chat-model'
const modelStorageKey = (conversationId: string): string =>
  `${MODEL_STORAGE_PREFIX}:${conversationId}`

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
 * - 新会话首轮发出后，流里的 `data-run` 带回真实会话 id → `router.replace` 换成真实地址；
 *   页面层的 key 把 `new → 真实 id` 视为同一次会话（不重挂载），并让 `useChat` 的实例 id
 *   在组件生命周期内稳定，正在流的这一轮不中断；
 * - 切换会话 = 换地址：页面 key 递增、整棵对话区重挂载，历史由 `useEffect` 从库里重建。
 */
export function ChatConversation({ conversationId }: { conversationId: string }) {
  const client = useServerClient()
  const router = useRouter()
  const queryClient = useQueryClient()
  const isNew = isNewConversation(conversationId)

  const [modelId, setModelId] = useState<string>()
  /**
   * 本会话的**文件权限**（沙箱内的只读 / 可写）。
   *
   * 它决定不了"要不要沙箱"——那是部署配置；会话页只让用户在沙箱里选能不能写工作区。
   */
  const [fileAccess, setFileAccess] = useState<'read-only' | 'workspace-write'>(
    'workspace-write',
  )
  /** 选模型：写进浏览器，别只留在 state 里（见 `MODEL_STORAGE_PREFIX` 的说明） */
  const chooseModel = (next: string) => {
    setModelId(next)
    window.localStorage.setItem(modelStorageKey(conversationId), next)
  }
  /** 附件的上传通道（预签名直传对象存储）：点提交时先把文件传完，再带着 key 发这一轮 */
  const attachmentUpload = useAttachmentsUpload()
  /**
   * 附件大图查看器（图片可缩放拖动，其它文件按类型预览）。
   *
   * **页面级只挂一个**：待发附件与每条消息的附件都往它里面送"这次要看的那一组"，
   * 于是不用给每个附件条各配一份查看器状态。
   */
  const lightbox = useImageLightbox()

  /** 点附件里的图片：把这一组交给查看器（图片走缩放看图，其它走文件预览） */
  const previewAttachments = (items: readonly PromptAttachmentItem[], index: number) => {
    lightbox.open(
      items.map((item) => ({
        id: item.key,
        src: item.previewUrl ?? '',
        alt: item.filename,
        filename: item.filename,
        mediaType: item.mediaType,
        ...(item.bytes === undefined ? {} : { bytes: item.bytes }),
      })),
      index,
    )
  }
  const availableModels = useAvailableModels(modelId)
  /**
   * 本轮用的模型的**输入模态**（`null` = 未声明）。
   *
   * 与顶部模型选择器共用同一份查询缓存（`useAvailableModels` 的口径只写一次）。
   * 「未声明」（`null`）与「清单还没到手」（`undefined`）都**不禁用**上传：
   * 国内厂商普遍不给模态信息，硬禁用会把真正的视觉模型也误伤。
   */
  const inputModalities = currentModelModalities(availableModels.current)
  const attachmentsAllowed =
    inputModalities === undefined ||
    inputModalities === null ||
    inputModalities.includes('image') ||
    inputModalities.includes('file')
  /** 本轮改选的 agent（会话自带的 agentKey 由详情给出；这里是"覆盖值"，null 表示未覆盖） */
  const [agentKeyOverride, setAgentKeyOverride] = useState<string | null>(null)
  const [runId, setRunId] = useState<string>()
  /**
   * **续跑中**（回答完工具挂起的问题之后，同一轮在服务端继续生成）。
   *
   * 为什么必须单独记：续跑不走 `useChat` 的 `sendMessage`，`status` 会一直停在 `ready` ——
   * 于是"AI 正在处理"的指示消失、输入框的停止按钮也没了，用户看起来像这一轮已经结束。
   * 这个标记让续跑也进入 `streaming` 口径（与普通一轮同一种表现）。
   */
  const [resuming, setResuming] = useState(false)
  const [errorText, setErrorText] = useState<string>()
  const [loading, setLoading] = useState(!isNew)
  /** 右栏（系统指令 / 子 agent 运行）是否显示；真实值由挂载后的 effect 从浏览器里读回来 */
  const [panelOpen, setPanelOpen] = useState(false)
  /** 手机端右栏是全屏 Sheet，不和桌面分栏共用 panelOpen（桌面 localStorage 可能为 true） */
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false)
  const isMobile = useIsMobile()
  const mobileNav = useChatMobileNav()

  useEffect(() => {
    setMobilePanelOpen(false)
  }, [conversationId])
  /**
   * 用户是否**自己开合过**右栏（`undefined` = 还没从浏览器读回来）。
   *
   * 只用于"要不要自动展开"这一件事：动过一次手，此后一律听用户的（见下面的自动展开 effect）。
   * 判据来自持久化的那个 key —— **key 存在 = 用户动过手**（自动展开不写 key，所以"没动过"不会被误判成"动过"）。
   * `undefined` 这一档是为了**不等读回就下判断**：自动展开与"读回用户意图"是同一个挂载周期里的
   * 两个 effect，先读后判才不会在"用户早就关过"的会话上又弹一次。
   */
  const [panelToggledByUser, setPanelToggledByUser] = useState<boolean | undefined>(undefined)
  /**
   * **切右栏 tab 的请求**（`null` = 没有请求）。
   *
   * 为什么是"请求 + nonce"而不是"当前 tab"：tab 的最终归属在用户手里，会话页只该**发一次请求**。
   * `nonce` 每次自增，面板只在它变化时响应 —— 于是"同一个请求"不会反复把用户切走的 tab 抢回来。
   *
   * 两个发起方：① 子助手开始跑时的自动展开（落到「子 agent」）；② 消息里紧凑计划卡的「查看清单」
   * （落到「任务」）。两者都只**请求**，用户随后的手动切换不受影响。
   */
  const [panelFocus, setPanelFocus] = useState<{ tab: RightPanelTab; nonce: number } | null>(null)
  const panelFocusNonce = useRef(0)

  /** 打开右栏并请求切到某个 tab（用户手动开合过之后，"自动展开"不再走这里，见下） */
  const focusRightPanel = useCallback((tab: RightPanelTab) => {
    panelFocusNonce.current += 1
    setPanelFocus({ tab, nonce: panelFocusNonce.current })
    setPanelOpen(true)
    setMobilePanelOpen(true)
  }, [])
  /**
   * 消息行上的"查看清单"入口：必须是**稳定引用**，否则 `ChatMessage` 的 memo 每帧都会失效
   * （整行重渲染 = 把刚省下的渲染成本又还回去）。
   */
  const openPlanPanel = useCallback(() => focusRightPanel('plan'), [focusRightPanel])
  // 停止按钮要用它；放在 ref 里避免每次拿到 runId 就重建 transport
  const runIdRef = useRef<string | undefined>(undefined)
  /**
   * 当前**真实的**会话 id（新会话在首轮发出前是 `undefined`）。
   *
   * 与路由参数分开：新会话时路由是 `.../new`，而发请求要带的是服务端给的 id（还是 undefined）。
   */
  const activeConversationIdRef = useRef<string | undefined>(isNew ? undefined : conversationId)
  /** 这棵对话区是不是从 `new` 开始的首轮（决定拿到 id 后要不要改地址） */
  const startedAsNewRef = useRef(isNew)
  /** 刚由本轮新建出来的会话 id：历史 effect 不要再把刚流进来的消息清掉 / 开 loading */
  const adoptedConversationRef = useRef<string | undefined>(undefined)
  /**
   * useChat 的实例 id 必须在**组件生命周期内稳定**。
   *
   * 不能直接写 `billy-ai-chat-${conversationId}`：`new → 真实 id` 时它会让 SDK 重建 Chat 状态，
   * 正在流的这一轮就被掐断。真正换会话时页面会用 key 重挂载，这里自然拿到新 id。
   */
  const chatIdRef = useRef(`billy-ai-chat-${conversationId}`)

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

  /** 打开已有会话时，文件权限以服务端为准 */
  useEffect(() => {
    const stored = conversationQuery.data?.fileAccess
    if (stored) setFileAccess(stored)
  }, [conversationQuery.data?.fileAccess])

  /**
   * 切换文件权限：已有会话立刻落库（要留审计），新会话先记在 state，随首条消息带过去。
   */
  const chooseFileAccess = (next: string) => {
    const value = next === 'read-only' ? 'read-only' : 'workspace-write'
    setFileAccess(value)
    const target = activeConversationIdRef.current
    if (!target) return
    void client.agent.conversation
      .setFileAccess({ conversationId: target, fileAccess: value })
      .then(() => queryClient.invalidateQueries({ queryKey: ['ai', 'conversation', target] }))
      .catch(() => toastError('切换文件权限失败，请重试'))
  }

  /**
   * transport 要**稳定引用**（每次渲染新建会让 useChat 反复重建内部状态）。
   * 它只依赖 client，会话 id / agentKey 走 ref 取最新值。
   */
  const agentKeyRef = useRef<string | undefined>(undefined)
  const modelIdRef = useRef<string | undefined>(undefined)
  const fileAccessRef = useRef<'read-only' | 'workspace-write'>('workspace-write')
  agentKeyRef.current = agentKey ?? undefined
  modelIdRef.current = modelId
  fileAccessRef.current = fileAccess

  /**
   * 开关状态用 effect 读回（而不是 `useState` 的惰性初值）：SSR 时读不到 localStorage，
   * 惰性初值会让首帧与 SSR 不一致（hydration 报错）；写成 effect，首帧两处都是"关"。
   */
  useEffect(() => {
    const stored = window.localStorage.getItem(PANEL_OPEN_STORAGE_KEY)
    // key 存在 → 用户以前自己开合过：把"用户意图优先"这件事也一并读回来
    if (stored !== null) {
      setPanelToggledByUser(true)
      setPanelOpen(stored === '1')
    }
  }, [])

  /**
   * 读回这个会话上次选的模型。
   *
   * 用 effect 而不是 `useState` 的惰性初值：SSR 时读不到 localStorage，惰性初值会让首帧
   * 与 SSR 不一致（hydration 报错）；写成 effect，首帧两边都是"服务端默认"，挂载后再纠正 ——
   * 与右栏开关同一套口径。
   */
  useEffect(() => {
    const stored = window.localStorage.getItem(modelStorageKey(conversationId))
    if (stored) setModelId(stored)
  }, [conversationId])

  /**
   * 存的选择已经不在可选清单里（模型被删 / 停用）：归零，交回服务端默认。
   *
   * 不清掉的话，发出去的是一个不存在的 id —— 服务端按"不静默回落"的原则直接报 3402
   * （§4.9.2 第 2 条），用户看到的是"每一轮都发不出去"，还看不出为什么。
   */
  useEffect(() => {
    if (!modelId || availableModels.models.length === 0) return
    if (availableModels.models.some((model) => model.id === modelId)) return
    setModelId(undefined)
    window.localStorage.removeItem(modelStorageKey(conversationId))
  }, [availableModels.models, conversationId, modelId])

  const togglePanel = () => {
    if (isMobile) {
      setMobilePanelOpen((current) => !current)
      return
    }
    const next = !panelOpen
    // 用户动过手 → 记下来：此后自动展开永远让位（与 tool-card 的 `userToggled` 同一条纪律）
    setPanelToggledByUser(true)
    // 手动开的时候按原口径落在「系统指令」：清掉上一次的切换请求，别让焦点粘住
    setPanelFocus(null)
    setPanelOpen(next)
    window.localStorage.setItem(PANEL_OPEN_STORAGE_KEY, next ? '1' : '0')
  }

  /** 复制会话 id（会话 id 是要贴给别人的东西：排障时一次贴清楚，比截图靠谱） */
  const copyConversationId = async () => {
    try {
      await copyText(conversationId)
      toastSuccess('已复制会话 id')
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error))
    }
  }

  const transport = useMemo(
    () =>
      new ChatTransport({
        api: client.agent.chatStreamUrl(),
        // 鉴权头与普通请求同一套（未登录返回 {}，后端会回 401）
        headers: async () => client.agent.authHeaders(),
        /**
         * 我们的建流接口收的是**业务入参**（`{ conversationId?, agentKey?, modelId?, message, attachments? }`），
         * 不是 AI SDK 默认的 `{ messages, id, trigger }` —— 在这里做一次转换。
         *
         * 附件为什么从 `requestMetadata` 取、而不是从消息的 file part 里反推：file part 里装的是
         * **预览地址**（本地 blob / 对象存储直链），而服务端要的是**存储 key** ——
         * key 只有上传那一步才知道。所以上传结果随 `sendMessage` 的 metadata 一起过来，
         * 消息本身只负责"界面上长什么样"。
         */
        prepareSendMessagesRequest: ({ messages, requestMetadata }) => {
          const last = messages.at(-1)
          const message = (last?.parts ?? [])
            .filter((part) => isTextUIPart(part))
            .map((part) => part.text)
            .join('\n')
            .trim()
          const attachments = attachmentMetadataOf(requestMetadata)
          return {
            body: {
              // 已有会话就带上；新会话不带（服务端会建一个，并从流里把 id 回给我们）
              ...(activeConversationIdRef.current
                ? { conversationId: activeConversationIdRef.current }
                : {}),
              ...(agentKeyRef.current ? { agentKey: agentKeyRef.current } : {}),
              // 这一轮用哪个模型（后台配过且启用的）：服务端会校验，不可用直接报错，**不静默回落**
              ...(modelIdRef.current ? { modelId: modelIdRef.current } : {}),
              // 会话的文件权限（沙箱内只读 / 可写）；新会话据此建，已有会话顺带同步
              fileAccess: fileAccessRef.current,
              message,
              ...(attachments.length > 0 ? { attachments } : {}),
            },
          }
        },
        /**
         * 断线重连：**一定要指向一个允许 GET 的地址**。
         *
         * AI SDK 的 `reconnectToStream` 固定发 GET，而建流端点是 POST-only ——
         * 这里如果退回建流地址，浏览器就会对 `POST /agent/chat/stream` 发一次 GET，**404**
         * （踩过的坑）。所以用"在当前会话里找进行中那一轮"的端点：
         * 有在跑的流就补发接回，没有就 204，SDK 静默收尾。
         *
         * **必须带上当前会话 id**：不带的话服务端只按登录用户跨会话找最近一条，
         * 切到已跑完的会话 B 时会把会话 A 正在跑的那一轮接进来（串流）。
         * 新会话页还没有真实 id，传占位段 `new` —— 永不匹配任何 run → 204，不接别人的流。
         */
        prepareReconnectToStreamRequest: () => ({
          api: client.agent.currentRunStreamUrl(
            0,
            activeConversationIdRef.current ?? NEW_CONVERSATION_SLUG,
          ),
        }),
      }),
    [client],
  )

  /**
   * 会话渲染状态：parts → 渲染单元的增量归约 + 子助手实时数据（见 `chat-session.ts`）。
   *
   * store 由**页面层**（`[conversationId]/page.tsx` 的 `ChatSessionProvider`）创建并下发 ——
   * 不能在本组件里建：Provider 一旦是本组件 `return` 的一部分，组件体里的 `useContext`
   * 永远读不到它（SSR 直接报"会话 store 缺失"，整页退化为客户端渲染）。
   */
  const sessionStore = useChatSessionStore()

  const { messages, sendMessage, status, stop, setMessages, error, clearError, resumeStream } = useChat({
    // 实例 id 整个组件生命周期稳定；换会话由页面 key 重挂载来隔离
    id: chatIdRef.current,
    transport,
    // 挂载即尝试重连（React 19 StrictMode 下有并发去重，别自己在 useEffect 里调 resumeStream）
    resume: true,
    experimental_throttle: 60,
    onData: (part) => {
      /**
       * 实时过程进 store：子助手的状态 / 增量在这里合并成"当前值"。
       *
       * 为什么不在渲染期从 parts 收集：逐帧增量以前会一块一个 part，数万条把页面拖死；
       * 现在增量块在传输层被标成 transient（不落 part），只走这里 —— 数据照样逐块到达，
       * 但一次追加是 O(1)，并且由 store 按 100ms 合并通知，不让每个增量都进 React。
       */
      sessionStore.applyChunk(part as { type: string; id?: string; data?: unknown })
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
        // 会话列表现在是 infinite query（多页），实时改名要把每一页都改到
        queryClient.setQueryData<InfiniteData<AppPageQueryResponse<AgentConversationModel>>>(
          ['ai', 'conversations'],
          (current) =>
            current
              ? {
                  ...current,
                  pages: current.pages.map((page) => ({
                    ...page,
                    items: page.items.map((item) =>
                      item.id === targetId ? { ...item, title: data.title! } : item,
                    ),
                  })),
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
        if (startedAsNewRef.current) {
          // 先记住"这个 id 是本轮流出来的"：历史 effect 不能把它当成"打开了一个已有会话"
          // 去开 loading / 覆盖消息
          adoptedConversationRef.current = data.conversationId
          /**
           * 模型选择要跟着会话搬家：地址换掉之后对话区会重挂载（见 `MODEL_STORAGE_PREFIX`），
           * 新组件按**真实 id** 读回选择 —— 这里先把 `new` 那一份落到真实 id 上，
           * 否则重挂载后读不到，选择又回到默认。
           */
          const pendingModelId = window.localStorage.getItem(modelStorageKey(conversationId))
          if (pendingModelId) {
            window.localStorage.setItem(modelStorageKey(data.conversationId), pendingModelId)
          }
          // new → 真实 id 是同一次发送：先标记，页面换地址时沿用同一个 store / useChat
          markAdoptedConversation(data.conversationId)
          // 地址换掉但不滚动；正在流的这一轮由 `useChat`（按 id 存的实例）接住，不中断
          router.replace(conversationPath(data.conversationId), { scroll: false })
        }
      }
    },
    /**
     * 错误显示**只取信封里的 `message`**，不把整段 JSON 甩给用户（截图里那串大括号就是它）。
     *
     * 3306（会话忙）额外说明一句：它通常不是"新消息出错"，而是**上一轮还在服务端跑**
     * （页面连接断过 / 刚重启过，前端以为空闲了）—— 告诉用户"等它结束或刷新接回"，
     * 比只显示"请稍候"更能解释他看到的异常。
     */
    onError: (chatError) => {
      const info = parseChatError(chatError)
      setErrorText(
        info.code === 3306
          ? `${info.message}（上一轮可能还在服务端生成：等它结束，或刷新页面接回进度）`
          : info.message,
      )
    },
  })

  /**
   * useChat 的 messages → 会话渲染状态（增量归约）。
   *
   * 只处理"新增的 part"与"尾部被就地更新的那一个"：流式文本 / 工具结果都是原位更新，
   * 所以这一步的成本与"这一帧新增了多少内容"成正比，而不是与整条消息的长度成正比。
   */
  useEffect(() => {
    sessionStore.sync(messages)
  }, [sessionStore, messages])

  // 续跑也算"在跑"：它不走 `useChat` 的发送通道，`status` 不会自己变成 streaming
  const streaming = status === 'streaming' || status === 'submitted' || resuming

  /**
   * **开跑即刷一次会话列表**：让侧栏「运行中」呼吸灯立刻亮。
   *
   * 列表本身是**条件轮询**（只有缓存里已有 `item.running` 才每 5s 拉一次），而它的失效
   * 原先只有「新会话 id 首次出现」与「一轮跑完」两处 —— **已有会话开第 2 轮时两头都不触发**：
   * 列表不重取，条件轮询又因缓存里没有 running 的项而不会自启，`running` 一直停在 false。
   *
   * 触发条件是 `status === 'streaming'`（或续跑），**不含 `submitted`**：点发送时服务端可能
   * 还没建好 run 行，抢跑会查到 `running=false`，这一轮就白刷了（ref 已去重，不会补第二次）。
   * 每轮只失效一次；熄灭仍由下面「跑完对账」负责。
   */
  const startedRunning = status === 'streaming' || resuming
  const startInvalidated = useRef(false)
  useEffect(() => {
    if (!startedRunning) {
      startInvalidated.current = false
      return
    }
    if (startInvalidated.current) return
    startInvalidated.current = true
    void queryClient.invalidateQueries({ queryKey: ['ai', 'conversations'] })
  }, [startedRunning, queryClient])

  /**
   * 服务端还在跑、但本地流已经断了（典型：回答挂起问题后续跑流断开 / 页面被切走又回来）
   * 时，DB 的 `running` 才是事实。这里轮询详情，发现 running 就调一次 `resumeStream()`
   * 接回 Redis 输出记录；成功后续跑流会把 streaming 顶起来。
   */
  const activeRunQuery = useQuery({
    queryKey: ['ai', 'active-run', conversationId],
    queryFn: () => client.agent.conversation.detail({ conversationId }),
    enabled: !isNew && !streaming,
    refetchInterval: (query) => (query.state.data?.running ? 2000 : false),
  })
  const reconnectedFor = useRef<string | null>(null)
  useEffect(() => {
    if (isNew || streaming || !activeRunQuery.data?.running) {
      if (!activeRunQuery.data?.running) reconnectedFor.current = null
      return
    }
    if (reconnectedFor.current === conversationId) return
    reconnectedFor.current = conversationId
    void resumeStream().finally(() => {
      // 204 / 没有可补发的流：允许下一轮轮询再试；成功时 streaming 会接管
      reconnectedFor.current = null
    })
  }, [activeRunQuery.data?.running, conversationId, isNew, resumeStream, streaming])

  /**
   * 右栏「子 agent」要用的**实时过程**：从最后一条含子助手块的消息里收（见 `sub-agent-live.ts`）。
   *
   * 为什么在会话页收、往下传：面板与消息在**同一次渲染**里，直接把这份数据递给面板即可
   * —— 不必为"运行中"另开后端接口，也不必让面板自己去猜哪条消息里有增量。
   * 跑完之后右栏改用库里的完整时间线，所以这份数据是"实时的那一份"，不是唯一来源。
   */
  /** 渲染用的消息列表（归约后的单元）：组件只吃这一份，不再回头扫 parts */
  const messageStates = useChatMessages()

  /**
   * **整个会话的当前计划**（右栏「任务」tab 的数据）。
   *
   * 与消息里那张紧凑卡**同一份收集逻辑**（`conversationPlanOf` 内部就是逐消息调 `collectMessagePlan`），
   * 所以两处显示的进度永远一致；这里只是把范围从"一条消息"放大到"整会话"，
   * 因为规划工具可能在任意一轮被调用（第一轮建清单、第五轮改顺序）。
   */
  const conversationPlan = useMemo(
    () => conversationPlanOfPlans(messageStates.map((state) => state.plan)),
    [messageStates],
  )

  /**
   * 当前**还没回答**的问题卡。主区把它固定在输入框上方，不跟消息滚走；
   * 已回答（`resumed=true`）或没有挂起时为 null。
   */
  const activeQuestion = useMemo<SuspendedPartData | null>(() => {
    for (let messageIndex = messageStates.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const units = messageStates[messageIndex]?.units ?? []
      for (let unitIndex = units.length - 1; unitIndex >= 0; unitIndex -= 1) {
        const unit = units[unitIndex]!
        if (unit.kind !== 'question') continue
        if (unit.data.resumed !== true && unit.data.suspendPayload) return unit.data
      }
    }
    return null
  }, [messageStates])

  /**
   * 窄屏（<768px）不放右栏的**自动展开**。
   *
   * 右栏不是覆盖层而是**分栏挤压**（`ResizablePanelGroup` 里的一栏），窄屏上一开就把对话区挤到
   * 不足 40% 宽 —— 正文被压成一条，"自动"反倒帮了倒忙。真要看得自己点页头那个按钮。
   * `useIsMobile` 与 layout 隐藏会话列表栏是同一套口径（首帧返回 false，挂载后纠正）。
   */
  /**
   * **子助手正在跑**（不是"历史里有子助手"）—— 只有这种情况才值得把右栏自动推给用户。
   *
   * 为什么区分这两件事：翻看**旧会话**时历史里往往躺着一堆已结束的子助手，
   * 那时自动弹开右栏是**打扰**（用户在看结论，不需要过程）；而运行中弹开是**帮忙**
   * （过程在流里长出来，不弹开就只能看到一句"过程见右栏"）。已结束的那些，
   * 紧凑卡上的入口与页头按钮都在，想看随时点。
   */
  const hasActiveSubAgent = useHasActiveSubAgent()
  /** 正在跑的子助手名字（运行指示用；只在这一项变化时重渲染） */
  const activeSubAgentName = useActiveSubAgentName()

  /**
   * **有子助手正在跑就自动展开一次右栏**。
   *
   * 为什么需要：子助手在主时间线只有一张紧凑卡（结论 + "过程见右栏"），过程全在右栏 ——
   * 面板默认关着的话，那句话就是空话（用户报的"子助手的输出没在右侧面板显示"就有这一层）。
   *
   * 五条约束：
   * - **只在运行中自动开**：判据是 `hasActiveSubAgent`，翻旧会话不会被弹开（见上）；
   * - **用户手动优先**：判据直接复用 `tool-card.tsx` 的 `shouldAutoOpen`（"有东西可看"+"用户没动过手"），
   *   不另造一套；`panelToggledByUser` 为真之后永远不再自动开；
   * - **窄屏不自动开**：见 `isMobile`（分栏挤压，不是覆盖层，但仍会把正文挤没）；
   * - **活动期不反复触发**：判据吃的是布尔量，同一段活动里 effect 不会重复跑；
   * - **自动展开要落在「子 agent」tab 上**：面板默认停在「系统指令」，自动开了却停在系统提示词上
   *   等于白开 —— 请求里的 tab 才是「子 agent」（用户自己开/自己切都不受影响）。
   */
  useEffect(() => {
    if (isMobile) return
    // 用户意图还没读回来（同一挂载周期里先读后判）→ 这次先不动，读回后 effect 会重跑
    if (panelToggledByUser === undefined) return
    if (!shouldAutoOpen(hasActiveSubAgent, panelToggledByUser)) return
    // 自动展开 = 一次"请切到子 agent"的请求（不写 localStorage：没动过手 ≠ 动过手）
    focusRightPanel('subagents')
  }, [isMobile, hasActiveSubAgent, panelToggledByUser])

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
    // new → 真实 id：消息已经在本轮流里，历史不需要再拉；
    // 这里若照常 setLoading(true)，就是用户看到的"发出去闪一下"。
    if (adoptedConversationRef.current === conversationId) {
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
        /**
         * 历史装载**不能直接覆盖**：挂载时 `useChat({ resume: true })` 可能已经接回正在跑的流，
         * 补发内容是边到边渲染的 —— 一覆盖就把已经渲染出来的部分抹掉，看起来就是"刷新后没重连"。
         * 按 id 归并：**同一条消息（messageId 相同）以流里那份为准**，历史只补它没有的那些。
         */
        const history = toUIMessages(items, runs)
        setMessages((current) => {
          if (current.length === 0) return history
          const liveIds = new Set(current.map((message) => message.id))
          return [...history.filter((message) => !liveIds.has(message.id)), ...current]
        })
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

  /**
   * 回答工具挂起的问题：POST `/agent/chat/resume`，拿到同一轮的续跑流，
   * 用 `readUIMessageStream` 把它并回**原助手消息**（不是新开一条）。
   *
   * 为什么不用 `useChat` 的 `sendMessage`：那会生成一条新的用户消息 / 新的一轮；
   * 挂起的语义是"同一轮从工具处继续"，用户答案不是新的聊天输入。
   *
   * 两条时序要求（都踩过）：
   * 1. **提交动作只覆盖"请求被接受"这一段**：早先整个函数 `await` 到续跑流结束才返回，
   *    于是服务端已经在疯狂输出、卡片却一直显示「提交中…」，用户以为没提交成功；
   * 2. **续跑期间要算"在跑"**（`resuming`）：否则 `useChat` 的 `status` 停在 `ready`，
   *    「AI 正在处理」的指示与停止入口都会消失。
   *
   * 所以：请求成功 → 立刻把这题标成"已回答"（dock 收起、时间线留只读记录）→ 打开 `resuming`
   * → 把续跑流交给后台消费，函数马上返回。
   */
  const answerQuestions = async (input: AnswerQuestionsInput) => {
    const response = await fetch(client.agent.chatResumeUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(await client.agent.authHeaders()),
      },
      body: JSON.stringify(input),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(detail || `续跑失败（HTTP ${response.status}）`)
    }
    if (!response.body) throw new Error('续跑没有返回流')

    const seed =
      messages.find((message) =>
        message.parts.some(
          (part) =>
            part.type === 'data-tool-call-suspended' &&
            (part as { data?: { toolCallId?: string } }).data?.toolCallId === input.toolCallId,
        ),
      ) ?? messages[messages.length - 1]
    if (!seed) return

    const seedIndex = Math.max(0, messages.indexOf(seed))
    /** 提交前那份挂起数据：续跑流里的同 id 块会覆盖它，问题原文得从这里补回来 */
    const seedSuspended = seed.parts.find((part) => {
      if (part.type !== 'data-tool-call-suspended') return false
      const data = (part as { data?: SuspendedPartData }).data
      return data?.toolCallId === input.toolCallId
    }) as { data?: SuspendedPartData } | undefined
    /**
     * 续跑块只带 `resumed: true`（AI SDK 同 id 后者覆盖前者），问题原文会被冲掉；
     * `markSuspendedAnswered` 负责补回 `suspendPayload` 并挂上本轮答案
     * —— 回答完的问题卡要在原位置留成记录（同一个函数也用于第一个续跑块到达之前）。
     */
    const withAnsweredRecord = (message: UIMessage): UIMessage =>
      markSuspendedAnswered(message, {
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        answers: input.answers ?? [],
        ...(input.cancelled ? { cancelled: true } : {}),
        ...(seedSuspended?.data?.suspendPayload
          ? { suspendPayload: seedSuspended.data.suspendPayload }
          : {}),
      })

    /**
     * **先把这题标成已回答**：不等第一个续跑块到达。
     *
     * 为什么要抢先：服务端从收到答案到吐出第一块之间有一段（模型重新起算）——
     * 这段时间里 dock 上的问题卡还挂着、按钮还是「提交中…」，用户看到的就是"没提交成功"。
     * 标成 answered 之后：dock 立刻收起，这组问答以只读形态留在时间线里。
     */
    setMessages((current) =>
      current.map((message, index) => (index === seedIndex ? withAnsweredRecord(message) : message)),
    )
    setResuming(true)

    /** 后台消费续跑流：不 await（上面的理由），失败只影响提示，不回滚已回答的记录 */
    void (async () => {
      try {
        const parsed = parseJsonEventStream({
          stream: response.body as ReadableStream<Uint8Array>,
          schema: uiMessageChunkSchema,
        }) as unknown as ReadableStream<
          { success: true; value: UIMessageChunk } | { success: false; error: unknown }
        >
        // `parseJsonEventStream` 交的是 `ParseResult`：成功解一层，失败直接终止流。
        const chunks = parsed.pipeThrough(
          new TransformStream<
            { success: true; value: UIMessageChunk } | { success: false; error: unknown },
            UIMessageChunk
          >({
            transform(result, controller) {
              if (result.success) controller.enqueue(result.value)
              else controller.error(result.error)
            },
          }),
        )
        // 续跑流若带新的 message id，SDK 会重置 parts（把这一轮前面的内容清掉）——
        // 先把 start 的 id 钉回原消息，续跑内容才会**追加**而不是覆盖
        const pinned = pinResumeMessageId(chunks, seed.id)
        for await (const updated of readUIMessageStream({ message: seed, stream: pinned })) {
          // 续跑是同一轮的延长：id 必须保持不变，否则界面上会多出一条助手消息
          setMessages((current) =>
            current.map((message, index) =>
              index === seedIndex ? withAnsweredRecord({ ...updated, id: seed.id }) : message,
            ),
          )
        }
      } catch (cause) {
        setErrorText(`续跑中断：${cause instanceof Error ? cause.message : String(cause)}`)
      } finally {
        // 收尾即回到空闲：`streaming` 随之回落，"轮结束后对账"那个 effect 会刷新列表与详情
        setResuming(false)
      }
    })()
  }

  return (
    <>
      <header className="flex min-w-0 items-center gap-2">
        {/* 独立布局没有左菜单：这里是**唯一的退出入口**（移动端列表栏本来就隐藏，更不能没有）。
            用图标按钮而不是文字链接（页头横向空间要留给标题与模型选择），形态与右侧的
            "复制会话 id" 一致 —— 都是 `IconText`，不自己拼按钮样式 */}
        <IconText
          icon={<LayoutDashboardIcon />}
          size="small"
          type="primary"
          tooltip="回到管理台"
          aria-label="回到管理台"
          onClick={() => router.push(Pages.dashboard)}
        />
        {isMobile && mobileNav ? (
          <IconText
            icon={<MessagesSquareIcon />}
            size="small"
            type="primary"
            tooltip="会话列表"
            aria-label="会话列表"
            onClick={mobileNav.openConversations}
          />
        ) : null}
        <h1 className="min-w-0 flex-1 truncate font-heading text-base font-semibold sm:text-lg">
          {isNew ? '新会话' : conversationQuery.data?.title || '会话'}
        </h1>
        {activeAgent ? (
          <Badge variant="secondary" className="hidden shrink-0 lg:inline-flex">{activeAgent.name}</Badge>
        ) : (
          <Badge variant="outline" className="hidden shrink-0 lg:inline-flex">未配置</Badge>
        )}
        {runId ? (
          <span className="hidden font-mono text-xs text-muted-foreground xl:inline">run {runId}</span>
        ) : null}
        {status !== 'ready' ? (
          <Badge variant={status === 'error' ? 'destructive' : 'outline'} className="hidden shrink-0 lg:inline-flex">{status}</Badge>
        ) : null}
        {/* 右侧：复制会话 id + 换 agent + 右栏开关 */}
        <div className="ml-auto flex items-center gap-2">
          {/* 新会话还没有 id（首轮发出后地址会换成真实 id，那时这个按钮才出现） */}
          {!isNew ? (
            <IconText
              icon={<CopyIcon />}
              size="small"
              type="primary"
              className="hidden lg:inline-flex"
              tooltip="复制会话 id"
              aria-label="复制会话 id"
              onClick={copyConversationId}
            />
          ) : null}
          {agents.length > 1 && (
            <div className="hidden lg:block">
              <DictSelect
                size="sm"
                triggerClassName="h-8 w-40"
                options={agents.map((agent) => ({ label: agent.name, value: agent.key }))}
                value={agentKey ?? agentsQuery.data?.defaultAgentKey ?? null}
                // 改选只对"接下来这一轮"生效（服务端每轮从入参取 agentKey）
                onValueChange={(next) => setAgentKeyOverride(next)}
                disabled={streaming}
              />
            </div>
          )}
          <Button
            variant={(isMobile ? mobilePanelOpen : panelOpen) ? 'secondary' : 'outline'}
            size="icon-sm"
            aria-pressed={isMobile ? mobilePanelOpen : panelOpen}
            aria-label={(isMobile ? mobilePanelOpen : panelOpen) ? '隐藏右栏' : '显示右栏'}
            title={(isMobile ? mobilePanelOpen : panelOpen) ? '隐藏右栏（系统指令 / 子 agent 运行）' : '显示右栏（系统指令 / 子 agent 运行）'}
            onClick={togglePanel}
          >
            <PanelRightIcon className="size-3.5" />
          </Button>
        </div>
      </header>

      {errorText || error ? (
        <Alert variant="destructive">
          <AlertDescription>{errorText ?? error?.message}</AlertDescription>
        </Alert>
      ) : null}

      {/* 对话区 + 右栏：可拖动分栏。右栏可关（页头那个图标），关掉时对话区独占整宽 */}
      {/*
        分栏组的高度**必须由 flex 决定**，不能吃库的内联 `height: 100%`：
        本页是「页头 + 分栏组」的竖排 flex，`100%` 按的是整个 section 的高度，
        会多出一个页头的高度（实测溢出 ~57px）。这层溢出被父级 `overflow-hidden` 裁掉后，
        最外层仍留下可被程序滚动的余量 —— 切右栏 tab 时焦点一动，整页就被顶上去一截。
        传 `height: auto` 覆盖掉内联值，交给 `flex-1` 分配"剩余空间"。
      */}
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        style={{ height: 'auto' }}
      >
        {/*
          `contain: paint` 是**必需**的，不是保险（实测）：右栏子助手记录能长到 8000px，
          即使被面板内部滚动区裁住，它的可滚动溢出仍会被算进 `document.scrollingElement.scrollHeight`
          （900 → 8149）——于是整页多出一条滚动条、切换 tab 时整屏被顶动。
          只加 `overflow: hidden` / `clip` 都压不住，`contain: paint` 才能把它从根滚动区隔离。
        */}
        <ResizablePanel
          minSize={320}
          className="h-full"
          style={{ overflow: 'hidden', contain: 'paint' }}
        >
          <div className="flex h-full min-h-0 flex-col gap-2">
            {/* 消息列表不画外框：整块与页面同底，气泡 / 工具卡自己带层次，边框只会把界面切成一块块 */}
            <Conversation className="min-h-0 flex-1">
              {/* 覆盖 ai-elements 的 `gap-8 p-4`：管理台是**高密度工作台**，
                  消息间距收到 12px、留白收到 12px（下面每张卡自己再收一层） */}
              <ConversationContent className="gap-3 p-3">
                {loading ? (
                  <p className="p-3 text-xs text-muted-foreground">正在加载会话历史…</p>
                ) : messageStates.length === 0 && messages.length > 0 ? (
                  <p className="p-3 text-xs text-muted-foreground">正在整理会话…</p>
                ) : messageStates.length === 0 ? (
                  <ConversationEmptyState className="gap-4">
                    <span className="grid size-11 place-items-center rounded-xl bg-surface-2 text-muted-foreground">
                      <BotIcon className="size-5" />
                    </span>
                    <div className="space-y-1.5">
                      <h3 className="font-heading text-base font-medium tracking-tight">
                        {isNew ? '问点什么' : '这个会话还没有内容'}
                      </h3>
                      <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
                        试着问「最近有哪些待办」，或让它「分步整理一份待办周报」——它会自己规划、必要时造一个子助手
                      </p>
                    </div>
                  </ConversationEmptyState>
                ) : (
                  messageStates.map((message) => {
                    // 只给"真的用得上"的行挂回调：其余行拿到稳定的 undefined，memo 才不会每帧失效
                    const needsPlan = message.plan !== null
                    const needsPreview = message.files.length > 0
                    const needsQuestion = message.units.some((unit) => unit.kind === 'question')
                    return (
                      <ChatMessage
                        key={message.id}
                        message={message}
                        streaming={streaming}
                        {...(needsPlan ? { onOpenPlan: openPlanPanel } : {})}
                        {...(needsPreview ? { onPreviewImage: previewAttachments } : {})}
                        {...(needsQuestion ? { onAnswerQuestions: answerQuestions } : {})}
                        // 计划卡 / 问题卡固定在输入框上方，消息流里不再重复
                        showTrailingCards={false}
                      />
                    )
                  })
                )}
              </ConversationContent>
              <ConversationScrollButton />
            </Conversation>

            {/* 输入框上方的常驻 dock：运行状态 / 当前任务进度 / 待回答的问题。
                放在 Conversation 外面，所以不会被消息列表滚走；问题卡永远贴着输入框。 */}
            <div className="flex max-h-[55vh] shrink-0 flex-col gap-2 overflow-y-auto px-3">
              <RunActivity
                messages={messages}
                status={resuming ? 'streaming' : status}
                activeSubAgentName={activeSubAgentName}
              />
              {conversationPlan ? (
                <PlanSummaryCard
                  plan={conversationPlan.current.plan}
                  onOpen={() => focusRightPanel('plan')}
                />
              ) : null}
              {activeQuestion ? (
                <QuestionCard data={activeQuestion} onSubmit={answerQuestions} />
              ) : null}
            </div>

            <div className="px-3 pb-3">
              <PromptInput
                /**
                 * 附件的大小 / 类型校验**刻意不交给 `PromptInput` 的 `maxFileSize` / `accept`**，
                 * 而是放在下面的提交预检（`scanFiles`）里做。两条原因：
                 *
                 * 1. `accept` 只是文件选择框的提示，**粘贴进来的文件根本不过它**，拦不住；
                 * 2. `maxFileSize` 是"整批里有一个超限就把**这一批全丢掉**"的粗粒度行为 ——
                 *    用户粘三张图、其中一张大了点，结果三张全没了，且提示只有一句"都超限"。
                 *
                 * 提交预检给的是逐文件的原因（哪个、为什么、多大），且**有不合格的就不发这一轮** ——
                 * 静默丢掉用户粘进来的东西，比让他重来一次更糟。
                 */
                accept={ATTACHMENT_ACCEPT}
                multiple
                onSubmit={async ({ text, files }) => {
                  const content = text.trim()
                  if ((!content && files.length === 0) || streaming || attachmentUpload.uploading) {
                    return
                  }

                  // 待发附件：只认本地文件（`files` 是 PromptInput 从附件状态里整理出来的）
                  const localFiles = files
                    .map((part) => part.rawFile)
                    .filter((file): file is File => file instanceof File)

                  const scanned = scanFiles(localFiles, inputModalities)
                  if (scanned.rejected.length > 0) {
                    // 有不合格的**整轮不发**：静默丢掉用户粘进来的东西，比让他重来一次更糟
                    toastError(rejectedText(scanned.rejected))
                    throw new Error('附件不符合要求，已取消本次发送')
                  }
                  /**
                   * 数量也整轮不发（与 `AgentChatSchema.attachments` 的 `.max()` 同一个常量）。
                   *
                   * 为什么不"自动只带前 N 个"：那等于**背着用户丢掉**他明确选中的文件，
                   * 而他以为都发出去了。宁可挡住这一轮、让他自己决定去掉哪几个。
                   */
                  if (scanned.accepted.length > CHAT_ATTACHMENT_MAX_COUNT) {
                    toastError(
                      `一轮最多带 ${CHAT_ATTACHMENT_MAX_COUNT} 个附件，当前有 ${scanned.accepted.length} 个，请先移除多余的`,
                    )
                    throw new Error('附件数量超出上限，已取消本次发送')
                  }

                  setErrorText(undefined)
                  clearError()

                  let attachments: ChatAttachmentModel[] = []
                  if (scanned.accepted.length > 0) {
                    try {
                      attachments = await attachmentUpload.upload(scanned.accepted)
                    } catch (uploadError) {
                      const reason =
                        uploadError instanceof Error ? uploadError.message : String(uploadError)
                      toastError(`附件上传失败：${reason}`)
                      // 抛出去让 `PromptInput` 知道"这一轮没发成"，输入框里的附件与文字都留着
                      throw uploadError
                    }
                  }

                  await sendMessage(
                    {
                      text: content,
                      // 直接把附件 part 交给 useChat：消息里因此带上 file part，气泡里就能显示附件。
                      // 真正发给服务端的不是它，而是 metadata 里那份"存储 key + 元数据"
                      // （part 里装的是预览地址，服务端要的是 key，见 prepareSendMessagesRequest）
                      ...(files.length > 0 ? { files } : {}),
                    },
                    { metadata: { attachments } },
                  )
                }}
              >
                {/* 待发附件条：粘完、发之前就能看清带了什么（图给缩略图，别的给文件名与大小） */}
                <PromptInputBody>
                  <PromptInputAttachmentsBar onPreviewImage={previewAttachments} />
                  <PromptInputTextarea
                    placeholder={`说说你想做什么…（⌘/Ctrl + Enter 发送，Enter 换行；可粘贴图片或文件，${ATTACHMENT_LIMIT_TEXT}）`}
                    submitOn="mod+enter"
                  />
                </PromptInputBody>
                {/* 左下角：本轮用哪个模型；右下角：本轮统计 + 发送/停止 */}
                <PromptInputFooter className="flex-wrap gap-2 sm:flex-nowrap">
                  <PromptInputTools>
                    <ModelPicker value={modelId} onChange={chooseModel} disabled={streaming} />
                    <span
                      className="shrink-0"
                      title="沙箱内的文件权限：可写 = 能改本会话工作区；只读 = 不能改（临时目录除外）。能不能出沙箱由部署决定，用户选不到"
                    >
                      <SegmentedControl
                        size="sm"
                        value={fileAccess}
                        options={[
                          { value: 'workspace-write', label: '可写' },
                          { value: 'read-only', label: '只读' },
                        ]}
                        onValueChange={chooseFileAccess}
                        disabled={streaming}
                      />
                    </span>
                    {/* 点击上传的入口：粘贴之外总得有"点一下选文件"这条路 */}
                    <PromptInputAttachmentButton
                      disabled={streaming || !attachmentsAllowed}
                      tooltip={
                        streaming
                          ? '正在回复中，回复结束后再上传'
                          : attachmentsAllowed
                            ? '上传图片或文件（也可直接粘贴）'
                            : '当前模型不支持图片 / 文件输入：可在后台「模型管理」声明，或换一个模型'
                      }
                    />
                    {!attachmentsAllowed ? (
                      <span className="hidden text-xs text-muted-foreground sm:inline">当前模型不支持附件</span>
                    ) : inputModalities === null ? (
                      // 未声明 ≠ 不支持：国内厂商的"列模型"接口普遍不给模态，所以只提醒、不拦。
                      // 真不能收图时，服务端会明确报错（3312），比在这里瞎猜强。
                      <span
                        className="hidden text-xs text-muted-foreground sm:inline"
                        title="后台「模型管理」里可以声明该模型支持哪些输入模态"
                      >
                        该模型未声明输入模态，图片 / 文件可能读不了
                      </span>
                    ) : null}
                    {attachmentUpload.uploading ? (
                      <span className="text-xs text-muted-foreground">
                        正在上传附件 {attachmentUpload.progress.done}/{attachmentUpload.progress.total}…
                      </span>
                    ) : null}
                  </PromptInputTools>
                  <div className="flex min-w-0 items-center gap-2">
                    <RunUsageInline usage={usage} turn={turn} />
                    {/* 流式中这个按钮就是"停止"（内部按 status 换成方块图标），onStop 里做真正的取消 */}
                    <PromptInputSubmit status={resuming ? 'streaming' : status} onStop={() => void stopRun()} />
                  </div>
                </PromptInputFooter>
              </PromptInput>
            </div>
          </div>
        </ResizablePanel>

        {panelOpen && !isMobile ? (
          <>
            {/* 分隔条：1px 发丝线（与左栏分隔条同一套交互） */}
            <ResizableHandle className="mx-2 bg-surface-3 transition-colors data-[separator=hover]:bg-primary/40 data-[separator=active]:bg-primary" />
            <ResizablePanel
              defaultSize={PANEL_WIDTH.default}
              minSize={PANEL_WIDTH.min}
              maxSize={PANEL_WIDTH.max}
              className="h-full"
              // 同左栏：子助手过程是长文档，必须把它的可滚动溢出从根滚动区隔离出去
              style={{ overflow: 'hidden', contain: 'paint' }}
            >
              <ConversationRightPanel
                client={client}
                // 新会话还没有 id：系统指令仍可看静态定义，子 agent tab 给空态
                conversationId={isNew ? undefined : conversationId}
                agentKey={agentKey ?? agentsQuery.data?.defaultAgentKey}
                // 技能 tab 从消息 parts 里取"激活过什么"：实时更新，不额外拉时间线
                messages={messages}
                // 自动展开时直接停在「子 agent」——自动开了却停在系统提示词上等于白开
                plan={conversationPlan}
                files={conversationQuery.data?.aiFiles ?? []}
                focus={panelFocus}
              />
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>

      {/* 手机端右栏：全屏 Sheet，不参与桌面分栏（否则会把对话区挤没） */}
      {isMobile ? (
        <Sheet open={mobilePanelOpen} onOpenChange={setMobilePanelOpen}>
          <SheetContent
            side="right"
            className="flex w-full max-w-none flex-col p-0 data-[side=right]:w-full data-[side=right]:max-w-none data-[side=right]:sm:max-w-none"
            style={{ width: '100%', maxWidth: 'none', height: '100dvh' }}
          >
            <SheetHeader className="sr-only">
              <SheetTitle>会话详情</SheetTitle>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-hidden p-2">
              <ConversationRightPanel
                client={client}
                conversationId={isNew ? undefined : conversationId}
                agentKey={agentKey ?? agentsQuery.data?.defaultAgentKey}
                messages={messages}
                plan={conversationPlan}
                files={conversationQuery.data?.aiFiles ?? []}
                focus={panelFocus}
              />
            </div>
          </SheetContent>
        </Sheet>
      ) : null}

      {/* 附件查看器：挂在会话页最外层，全局只有一个实例 */}
      {lightbox.lightbox}
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
