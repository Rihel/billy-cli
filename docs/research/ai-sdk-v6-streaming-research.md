# AI SDK v6 + AI Elements 全量流式呈现调研报告

> **状态：调研快照（写作时点）。** 外部库版本与线上文档会继续演进，本文结论不随本仓库代码更新；
> 当前实现见 [`docs/guide/`](../guide/) 与 [`docs/design/`](../design/)。

调研对象：`ai@6.0.289`、`@ai-sdk/react@3.0.292`（`npm pack` 后读包内 `.d.ts` / `src/` / 内置 `docs/`）、AI Elements registry（`curl https://elements.ai-sdk.dev/api/registry/<name>.json`）。

**引用代号**：`ai/dist:L{n}`=`ai@6.0.289/dist/index.d.ts` 第 n 行；`react/dist:L{n}` 同理；`ai/src:{path}:L{n}`=包内源码；`docs:{file}:L{n}`=包内**官方文档**（`.mdx`，与线上 `ai-sdk.dev/docs` 同版本，行号可复现）；`reg:{name}:L{n}`=registry JSON 内嵌源码行号。

> ⚠️ **务必注意版本漂移**：线上 `ai-sdk.dev` 当前 Latest 已是 **v7**，直接抓网页会混入 v7 内容（例如 `resume` 选项的表述）。本报告因此**一律以 `ai@6.0.289` tarball 自带 `docs/**.mdx` 为一手材料**，并用同版本 `.d.ts` / `src/` 交叉核对。凡引用 `docs:` 处，请对照「本地文件:行号 ↔ 官方 URL」理解。

---

## 1. 结论摘要

1. **`UIMessage.parts` 是唯一地基**：`UIMessagePart` 是 **9 类联合**——`text`/`reasoning`/`tool-<name>`/`dynamic-tool`/`source-url`/`source-document`/`file`/`data-<name>`/`step-start`（`ai/dist:L1615`）。
2. **chunk ≠ part**：传输层 `UIMessageChunk` 有 **24 个字面量 + `data-<name>` 通配**；part 是 chunk 归并后的有状态结果（3 个 `text-*` chunk → 1 个 `text` part）。
3. **v6 续传方法名是 `resumeStream()`**（`ai/dist:L3906`），不是 `reconnectToStream()`；后者是**传输层**接口名（`ai/dist:L3687`），由前者内部调用。默认续传为 **`GET {api}/{chatId}/stream`**，服务端须以 **`204`** 表示"无进行中的流"。
4. **续传存储须自建**：SDK 只给 `resume` 选项、`consumeSseStream` 回调与自动请求；Redis、activeStreamId 记录、POST/GET 两端点、`resumable-stream` 集成都要自己做（`docs:04-ai-sdk-ui/03-chatbot-resume-streams.mdx:L23-45`）。
5. **AI Elements 几乎全是无状态展示组件**：8 个核心组件无一 `import { useChat }`、无一读 `message.parts`，运行态必须由调用方从 parts 取出当 props 传入。真有运行态判断的只有 `reasoning`/`tool`/`confirmation`/`plan`/`terminal`/`conversation`。
6. **自定义状态机走 `data-*`**：带固定 `id` 的持久 data part 同 id 重写即**就地更新**；`transient: true` 的瞬时报文**只走 `onData`，绝不进 `parts`**（`ai/src:ui/process-ui-message-stream.ts:900-902`）。
7. **坑**：`isToolUIPart` 在 v6 **语义反转**；tool state 由 4 态扩到 7 态；`addToolResult`→`addToolOutput`；**官方文档里 `writer.write({type:'source'})` 与 `consumeSseStream` 的签名都是错的**。

---

## 2. UI Message Stream 的完整 part 清单

```ts
// ai/dist:L1590-1614
interface UIMessage<METADATA = unknown, DATA_PARTS extends UIDataTypes = UIDataTypes,
                    TOOLS extends UITools = UITools> {
  id: string;
  role: 'system' | 'user' | 'assistant';
  metadata?: METADATA;
  parts: Array<UIMessagePart<DATA_PARTS, TOOLS>>;
}

// ai/dist:L1615
type UIMessagePart<DATA_TYPES extends UIDataTypes, TOOLS extends UITools> =
  | TextUIPart | ReasoningUIPart | ToolUIPart<TOOLS> | DynamicToolUIPart
  | SourceUrlUIPart | SourceDocumentUIPart | FileUIPart
  | DataUIPart<DATA_TYPES> | StepStartUIPart;
```

```ts
// ai/dist:L1619-1633
type TextUIPart = { type: 'text'; text: string;
  state?: 'streaming' | 'done'; providerMetadata?: ProviderMetadata; };
// ai/dist:L1637-1655
type ReasoningUIPart = { type: 'reasoning'; id?: string; text: string;
  state?: 'streaming' | 'done'; providerMetadata?: ProviderMetadata; };
// ai/dist:L1659-1665
type SourceUrlUIPart = { type: 'source-url'; sourceId: string; url: string;
  title?: string; providerMetadata?: ProviderMetadata; };
// ai/dist:L1669-1676
type SourceDocumentUIPart = { type: 'source-document'; sourceId: string; mediaType: string;
  title: string; filename?: string; providerMetadata?: ProviderMetadata; };
// ai/dist:L1680-1701
type FileUIPart = { type: 'file'; mediaType: string; filename?: string; url: string;
  providerMetadata?: ProviderMetadata; };
// ai/dist:L1705-1707
type StepStartUIPart = { type: 'step-start' };
// ai/dist:L1708-1714  —— data-<name> 通配
type DataUIPart<DATA_TYPES extends UIDataTypes> = ValueOf<{
  [NAME in keyof DATA_TYPES & string]: {
    type: `data-${NAME}`; id?: string; data: DATA_TYPES[NAME]; }; }>;
```

**工具 part：`state` 全部 7 态**（`ai/dist:L1725-1819`）：

```ts
type UIToolInvocation<TOOL extends UITool | Tool> = {
  toolCallId: string; title?: string;
  toolMetadata?: JSONObject; providerExecuted?: boolean;
} & (
  | { state: 'input-streaming';
      input?: DeepPartial<asUITool<TOOL>['input']> | undefined;
      output?: never; errorText?: never;
      callProviderMetadata?: ProviderMetadata; approval?: never; }
  | { state: 'input-available';
      input: asUITool<TOOL>['input'];
      output?: never; errorText?: never;
      callProviderMetadata?: ProviderMetadata; approval?: never; }
  | { state: 'approval-requested';
      input: asUITool<TOOL>['input']; output?: never; errorText?: never;
      callProviderMetadata?: ProviderMetadata;
      approval: { id: string; approved?: never; descriptor?: unknown;
                  reason?: never; signature?: string }; }
  | { state: 'approval-responded';
      input: asUITool<TOOL>['input']; output?: never; errorText?: never;
      callProviderMetadata?: ProviderMetadata;
      approval: { id: string; approved: boolean; descriptor?: unknown;
                  reason?: string; signature?: string }; }
  | { state: 'output-available';
      input: asUITool<TOOL>['input']; output: asUITool<TOOL>['output'];
      errorText?: never; callProviderMetadata?: ProviderMetadata;
      resultProviderMetadata?: ProviderMetadata; preliminary?: boolean;
      approval?: { id: string; approved: true; descriptor?: unknown;
                   reason?: string; signature?: string }; }
  | { state: 'output-error';
      input: asUITool<TOOL>['input'] | undefined; rawInput?: unknown;
      output?: never; errorText: string;
      callProviderMetadata?: ProviderMetadata;
      resultProviderMetadata?: ProviderMetadata;
      approval?: { id: string; approved: true; descriptor?: unknown;
                   reason?: string; signature?: string }; }
  | { state: 'output-denied';
      input: asUITool<TOOL>['input']; output?: never; errorText?: never;
      callProviderMetadata?: ProviderMetadata;
      approval: { id: string; approved: false; descriptor?: unknown;
                  reason?: string; signature?: string }; }
);

// ai/dist:L1820-1824  —— 静态工具，type 由工具名派生
type ToolUIPart<TOOLS extends UITools = UITools> = ValueOf<{
  [NAME in keyof TOOLS & string]: { type: `tool-${NAME}` } & UIToolInvocation<TOOLS[NAME]>; }>;

// ai/dist:L1825-1840  —— 动态工具，type 固定，另带 toolName；7 个 state 分支同构，input/output 为 unknown
type DynamicToolUIPart = { type: 'dynamic-tool'; toolName: string; toolCallId: string;
  title?: string; toolMetadata?: JSONObject; providerExecuted?: boolean; } & ( /* 同上 7 态 */ );
```

`approval-requested` / `approval-responded` / `output-denied` 是 **v6 新增**，v5 仅 4 态（`docs:08-migration-guides/24-migration-guide-6-0.mdx:528-556`）。

类型守卫（`ai/dist:L1927-1976`）：`isTextUIPart`、`isFileUIPart`、`isReasoningUIPart`、`isDataUIPart`、`isStaticToolUIPart`、`isDynamicToolUIPart`、`isToolUIPart`、`getStaticToolName`、`getToolName`。**语义在 v6 反转，见 7.1。**

---

## 3. SSE chunk（传输层）清单与响应头

运行时校验由 `uiMessageChunkSchema`（`ai/dist:L1990`）完成，定义在 `ai/src:ui-message-stream/ui-message-chunks.ts`，共 **24 个 `z.literal` + `data-` 通配**：

| # | chunk type | 关键字段（`ai/dist:L1999-2124`） |
| --- | --- | --- |
| 1-3 | `text-start` / `text-delta` / `text-end` | `id`、`delta`(仅 delta)、`providerMetadata?` |
| 4-6 | `reasoning-start` / `-delta` / `-end` | 同上 |
| 7 | `error` | `errorText` |
| 8 | `tool-input-start` | `toolCallId`,`toolName`,`providerExecuted?`,`toolMetadata?`,`dynamic?`,`title?` |
| 9 | `tool-input-delta` | `toolCallId`,`inputTextDelta` |
| 10 | `tool-input-available` | `toolCallId`,`toolName`,`input`,… |
| 11 | `tool-input-error` | 同 10 + `errorText` |
| 12 | `tool-approval-request` | `approvalId`,`toolCallId`,`approvalDescriptor?`,`signature?` |
| 13 | `tool-output-available` | `toolCallId`,`output`,…,`preliminary?` |
| 14 | `tool-output-error` | `toolCallId`,`errorText`,… |
| 15 | `tool-output-denied` | `toolCallId` |
| 16 | `source-url` | `sourceId`,`url`,`title?` |
| 17 | `source-document` | `sourceId`,`mediaType`,`title`,`filename?` |
| 18 | `file` | `url`,`mediaType`,`providerMetadata?` |
| 19-20 | `start-step` / `finish-step` | — |
| 21 | `start` | `messageId?`,`messageMetadata?` |
| 22 | `finish` | `finishReason?`,`messageMetadata?` |
| 23 | `abort` | `reason?` |
| 24 | `message-metadata` | `messageMetadata` |
| — | `data-<name>` | `id?`,`data`,`transient?`（`ai/dist:L1991-1998`） |

```ts
// ai/dist:L1991-1998
type DataUIMessageChunk<DATA_TYPES extends UIDataTypes> = ValueOf<{
  [NAME in keyof DATA_TYPES & string]: {
    type: `data-${NAME}`; id?: string; data: DATA_TYPES[NAME]; transient?: boolean; }; }>;
```

**chunk → part 映射（务必区分）**：

| chunk | 结果 |
| --- | --- |
| `text-start`/`-delta`/`-end` | 1 个 `text` part（`streaming`→`done`） |
| `reasoning-start`/`-delta`/`-end` | 1 个 `reasoning` part |
| `tool-input-start`/`-delta` | `tool-*` part，`state:'input-streaming'` |
| `tool-input-available` | 同 part → `input-available` |
| `tool-approval-request` | 同 part → `approval-requested` |
| `tool-output-available`/`-error`/`-denied` | 同 part → `output-available`/`output-error`/`output-denied`（`ai/dist:L2029-2074`） |
| `source-url`/`source-document`/`file` | 各自独立 part，不变形 |
| `data-<name>` | `data-<name>` part；`transient` 时**不产生 part**（`ai/src:ui/process-ui-message-stream.ts:900-902`） |
| `start` | **不产生 part**；仅设 `messageId` + metadata（`ai/src:ui/process-ui-message-stream.ts:833-843`） |
| `finish` | **不产生 part**；设 `finishReason` + metadata（同上 L846-853） |
| `start-step` | 产生 `step-start` part |
| `finish-step` | 多步拼接边界 |

**`start.messageId` 的作用**：服务端提前确定回复消息 id，客户端据此把流式内容写进同一条 `UIMessage.id`。`createUIMessageStream` 文档原文：*"`originalMessages`: If they are provided, persistence mode is assumed, and a message ID is provided for the response message."*（`ai/dist:L4271-4275`）；`streamText` 侧由 `generateMessageId` 控制（`ai/dist:L2205-2210`）。这是续传能"接回同一条消息"的基础。

**响应头**：

```ts
// ai/src:ui-message-stream/ui-message-stream-headers.ts:1-7
export const UI_MESSAGE_STREAM_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no', // disable nginx buffering
};
```

运行时实测（`node` 导入 `ai@6.0.289` 打印）与上述一致。`x-accel-buffering: no` 用于**关闭 nginx 缓冲**，否则 SSE 被攒包、不流式。

**可验证结论**：`x-vercel-ai-ui-message-stream` 在整个 `ai` 包中**仅此 1 处出现**；官方客户端 `HttpChatTransport` **不读取也不校验**它。它的作用是给自建/跨语言后端做协议自描述，不是握手。官方要求原文：*"When you provide data streams from a custom backend, you need to set the `x-vercel-ai-ui-message-stream` header to `v1`."*（`docs:04-ai-sdk-ui/50-stream-protocol.mdx:111-114`）

**SSE 线格式与 `[DONE]`**：

```ts
// ai/src:ui-message-stream/json-to-sse-transform-stream.ts:6-17
export class JsonToSseTransformStream extends TransformStream<unknown, string> {
  constructor() {
    super({
      transform(part, controller) {
        controller.enqueue(`data: ${JSON.stringify(part)}\n\n`);
      },
      flush(controller) {
        controller.enqueue('data: [DONE]\n\n');
      },
    });
  }
}
```

每事件 `data: {json}\n\n`（双换行），流以 `data: [DONE]\n\n` 结束（`docs:04-ai-sdk-ui/50-stream-protocol.mdx:412-423`）。各 chunk 官方线格式样例见同文件 L118-423，例如：

```
data: {"type":"start","messageId":"..."}

data: {"type":"text-delta","id":"msg_...","delta":"Hello"}

data: {"type":"tool-approval-request","toolCallId":"call_...","approvalId":"approval_123","approvalDescriptor":{"scope":"account:delete"}}

data: {"type":"data-weather","data":{"location":"SF","temperature":100}}

data: [DONE]
```

`approvalDescriptor` 官方语义：*"optional opaque metadata for the approval. When the stream is processed into UI messages, it is available as `part.approval.descriptor` and is retained when the client records an approval response."*（同上 L340-343）

---

## 4. `useChat` 的完整状态面

```ts
// react/dist:L13-25
type UseChatHelpers<UI_MESSAGE extends UIMessage> = {
  readonly id: string;
  setMessages: (messages: UI_MESSAGE[] | ((messages: UI_MESSAGE[]) => UI_MESSAGE[])) => void;
  error: Error | undefined;
} & Pick<AbstractChat<UI_MESSAGE>,
  'sendMessage' | 'regenerate' | 'stop' | 'resumeStream'
  | 'addToolResult' | 'addToolOutput' | 'addToolApprovalResponse'
  | 'status' | 'messages' | 'clearError'>;

// react/dist:L26-39
type UseChatOptions<UI_MESSAGE extends UIMessage> =
  ({ chat: Chat<UI_MESSAGE> } | ChatInit<UI_MESSAGE>) & {
    experimental_throttle?: number;   // 默认 undefined = 不节流
    resume?: boolean;                 // 是否挂载时接回进行中的流
  };
declare function useChat<UI_MESSAGE extends UIMessage = UIMessage>(
  { experimental_throttle: throttleWaitMs, resume, ...options }?: UseChatOptions<UI_MESSAGE>
): UseChatHelpers<UI_MESSAGE>;
```

**`status` 四态与官方语义原文**（`ai/dist:L3758-3764`）：

```ts
type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error';
/**
 * - `submitted`: The message has been sent to the API and we're awaiting the start of the response stream.
 * - `streaming`: The response is actively streaming in from the API, receiving chunks of data.
 * - `ready`: The full response has been received and processed; a new user message can be submitted.
 * - `error`: An error occurred during the API request, preventing successful completion.
 */
```

**动作方法**（`ai/dist:L3880-3918`）：

```ts
sendMessage: (
  message?: (CreateUIMessage<UI_MESSAGE> & { text?: never; files?: never; messageId?: string })
    | { text: string; files?: FileList | FileUIPart[];
        metadata?: InferUIMessageMetadata<UI_MESSAGE>; parts?: never; messageId?: string }
    | { files: FileList | FileUIPart[];
        metadata?: InferUIMessageMetadata<UI_MESSAGE>; parts?: never; messageId?: string },
  options?: ChatRequestOptions
) => Promise<void>;
regenerate: ({ messageId, ...options }?: { messageId?: string } & ChatRequestOptions) => Promise<void>;
/** Attempt to resume an ongoing streaming response. */
resumeStream: (options?: ChatRequestOptions) => Promise<void>;
clearError: () => void;
addToolApprovalResponse: ChatAddToolApproveResponseFunction;
addToolOutput: ChatAddToolOutputFunction<UI_MESSAGE>;
/** @deprecated Use addToolOutput */
addToolResult: ChatAddToolOutputFunction<UI_MESSAGE>;
stop: () => Promise<void>;

// ai/dist:L3706-3716 —— sendMessage 的 body/headers/metadata 全部来自这里
type ChatRequestOptions = {
  headers?: Record<string, string> | Headers;
  body?: object;
  metadata?: unknown;
};
```

`metadata` 会作为 `requestMetadata` 出现在 `PrepareSendMessagesRequest`/`PrepareReconnectToStreamRequest` 回参（`ai/dist:L3945,3966`），可传鉴权/租户 id；**它不进 `UIMessage.metadata`**（后者由服务端 `messageMetadata` 产生）。

**全部回调**（`ai/dist:L3770-3838`）：

```ts
type ChatOnErrorCallback = (error: Error) => void;
type ChatOnToolCallCallback<UI_MESSAGE extends UIMessage = UIMessage> = (options: {
  toolCall: InferUIMessageToolCall<UI_MESSAGE>; }) => void | PromiseLike<void>;
type ChatOnDataCallback<UI_MESSAGE extends UIMessage> =
  (dataPart: DataUIPart<InferUIMessageData<UI_MESSAGE>>) => void;
type ChatOnFinishCallback<UI_MESSAGE extends UIMessage> = (options: {
  message: UI_MESSAGE; messages: UI_MESSAGE[];
  isAbort: boolean; isDisconnect: boolean; isError: boolean;
  finishReason?: FinishReason;
}) => void;

interface ChatInit<UI_MESSAGE extends UIMessage> {
  id?: string;
  messageMetadataSchema?: FlexibleSchema<InferUIMessageMetadata<UI_MESSAGE>>;
  dataPartSchemas?: UIDataTypesToSchemas<InferUIMessageData<UI_MESSAGE>>;
  messages?: UI_MESSAGE[];
  generateId?: IdGenerator;
  transport?: ChatTransport<UI_MESSAGE>;
  onError?: ChatOnErrorCallback;
  onToolCall?: ChatOnToolCallCallback<UI_MESSAGE>;
  onFinish?: ChatOnFinishCallback<UI_MESSAGE>;
  onData?: ChatOnDataCallback<UI_MESSAGE>;
  sendAutomaticallyWhen?: (options: { messages: UI_MESSAGE[] }) => boolean | PromiseLike<boolean>;
}
```

`onFinish` 把 `isAbort`/`isDisconnect`/`isError` **三态分离**，是区分"用户停止/网络断开/真错误"的官方手段。

### 刷新/断线后如何接回正在进行的 run

**`resumeStream` 与 `reconnectToStream` 的分工（源码级证据）**：

```ts
// ai/src:ui/chat.ts:470-472
resumeStream = async (options: ChatRequestOptions = {}): Promise<void> => {
  await this.makeRequest({ trigger: 'resume-stream', ...options });
};

// ai/src:ui/chat.ts:644-661（节选）
// For resume-stream, check if there's an active stream before
// changing status. This avoids a brief flash of 'submitted' status
// when there is no stream to resume (e.g. on page load).
let resumeStream: ReadableStream<UIMessageChunk> | undefined;
if (trigger === 'resume-stream') {
  const reconnect = await this.transport.reconnectToStream({
    chatId: this.id, abortSignal: abortController.signal, metadata, headers, body,
  });
  ...
  if (reconnect == null) { this.setStatus({ status: 'ready' }); return; } // 无流则不 resume
  resumeStream = reconnect;
}
this.setStatus({ status: 'submitted', error: undefined });
...
stream = trigger === 'resume-stream' ? resumeStream! : await this.transport.sendMessages({...});

// ai/src:ui/http-chat-transport.ts:236-256
const api = preparedRequest?.api ?? `${this.api}/${options.chatId}/stream`;
const response = await fetch(api, { method: 'GET', headers, credentials, signal: options.abortSignal });
if (response.status === 204) { return null; }   // no active stream found, so we do not resume
```

**官方原文结论**（`docs:04-ai-sdk-ui/03-chatbot-resume-streams.mdx`）：

- 续传需持久化消息与 active stream，**SDK 不提供存储**（L23）；SDK 只给 `resume` 选项、`consumeSseStream` 拿到出站流、自动请求续传端点（L25-30）。
- 你须构建：chat↔stream 映射、Redis 存流、POST 建流 + GET 续流、`resumable-stream` 集成（L31-44）。
- *"When you enable `resume`, the `useChat` hook makes a `GET` request to `/api/chat/[id]/stream` on mount to check for and resume any active streams."*（L91）
- **能否不重跑已产出部分**：**源码层面能**——续传 GET 走 `transport.reconnectToStream()` 分支，**不再调 `sendMessages()`**，故不发起新模型请求（`ai/src:ui/chat.ts:655-660`）；服务端存整条 SSE 流，GET 时 `resumeExistingStream` 从头发给客户端。**但官方并未显式承诺"不重跑模型"**，措辞只是 *"reconnect to an active stream"* / *"keeps the stream running"*（L259-261）——"不会重跑"是**源码事实推论**。生命周期见 L200-213。
- **行为警告（L10-19）**：*"client-side aborts are treated as disconnects. Closing a tab, refreshing the page, or calling `stop()` only closes the current HTTP connection and should not cancel the underlying generation."* 即**启用 `resume` 后 `stop()` 不再取消生成**。

---

## 5. 服务端续传的实现要求

**POST：建流 + 存流**（`docs:04-ai-sdk-ui/03-chatbot-resume-streams.mdx:99-152` 原文）：

```ts filename="app/api/chat/route.ts"
import { openai } from '@ai-sdk/openai';
import { readChat, saveChat } from '@util/chat-store';
import { convertToModelMessages, generateId, streamText, type UIMessage } from 'ai';
import { after } from 'next/server';
import { createResumableStreamContext } from 'resumable-stream';

export async function POST(req: Request) {
  const { message, id }: { message: UIMessage | undefined; id: string } = await req.json();

  const chat = await readChat(id);
  let messages = chat.messages;
  messages = [...messages, message!];

  // Clear any previous active stream and save the user message
  saveChat({ id, messages, activeStreamId: null });

  const result = streamText({
    model: 'openai/gpt-5-mini',
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    generateMessageId: generateId,
    onFinish: ({ messages }) => {
      // Clear the active stream when finished
      saveChat({ id, messages, activeStreamId: null });
    },
    async consumeSseStream({ stream }) {
      const streamId = generateId();
      // Create a resumable stream from the SSE stream
      const streamContext = createResumableStreamContext({ waitUntil: after });
      await streamContext.createNewResumableStream(streamId, () => stream);
      // Update the chat with the active stream ID
      saveChat({ id, activeStreamId: streamId });
    },
  });
}
```

**GET：续流 + 204 响应约定**（同文件 L163-191 原文）：

```ts filename="app/api/chat/[id]/stream/route.ts"
import { readChat } from '@util/chat-store';
import { UI_MESSAGE_STREAM_HEADERS } from 'ai';
import { after } from 'next/server';
import { createResumableStreamContext } from 'resumable-stream';

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const chat = await readChat(id);

  if (chat.activeStreamId == null) {
    // no content response when there is no active stream
    return new Response(null, { status: 204 });
  }

  const streamContext = createResumableStreamContext({ waitUntil: after });

  return new Response(await streamContext.resumeExistingStream(chat.activeStreamId), {
    headers: UI_MESSAGE_STREAM_HEADERS,
  });
}
```

`after` 的作用原文：*"allows work to continue after the response has been sent. This ensures that the resumable stream persists in Redis even after the initial response is returned to the client, enabling reconnection later."*（L193-198）

**`consumeSseStream` 类型**（`ai/dist:L2179-2188`）：

```ts
type UIMessageStreamResponseInit = ResponseInit & {
  /**
   * Optional callback to consume a copy of the SSE stream independently.
   * This is useful for logging, debugging, or processing the stream in parallel.
   * The callback receives a tee'd copy of the stream and does not block the response.
   */
  consumeSseStream?: (options: { stream: ReadableStream<string> }) => PromiseLike<void> | void;
};
```

被 `toUIMessageStreamResponse`、`createUIMessageStreamResponse`、`pipeUIMessageStreamToResponse`、`createAgentUIStreamResponse`、`pipeAgentUIStreamResponse` 共同接受（`ai/dist:L2463,4296,4321,3569,4391`）。入参是**已序列化的 SSE 文本流**（非 chunk 流），所以存进 Redis 的可直接回放。

**只有一种形态（源码级裁定）**：实现是 `consumeSseStream({ stream: stream2 })`——**对象解构**传参，且**不 await**（注释原文 `// no await (do not block the response)`）：

```ts
// ai/src:ui-message-stream/create-ui-message-stream-response.ts:20-45
}: UIMessageStreamResponseInit & { stream: ReadableStream<UIMessageChunk> }): Response {
  let sseStream = stream.pipeThrough(new JsonToSseTransformStream());
  // when the consumeSseStream is provided, we need to tee the stream
  // and send the second part to the consumeSseStream function
  if (consumeSseStream) {
    const [stream1, stream2] = sseStream.tee();
    sseStream = stream1;
    consumeSseStream({ stream: stream2 }); // no await (do not block the response)
  }
  return new Response(sseStream.pipeThrough(new TextEncoderStream()), {
    status, statusText,
    headers: prepareHeaders(headers, UI_MESSAGE_STREAM_HEADERS),
  });
}
// ai/src:generate-text/stream-text.ts:3202-3229 —— toUIMessageStreamResponse 把 ...init（含 consumeSseStream）
// 原样透传给 createUIMessageStreamResponse，故形态完全相同
return createUIMessageStreamResponse({ stream: this.toUIMessageStream({...}), ...init });
```

两点重要推论：
- **不要写 `(stream) => ...`**。`docs:07-reference/01-ai-sdk-core/02-stream-text.mdx:3566` 把 `streamText` 的 `consumeSseStream` 记为 `(stream: ReadableStream) => Promise<void>`（并称 "Required for proper abort handling"）——**该文档条目与实现不符，是错的**；所有入口实际都是 `({ stream })`。
- 因为是 fire-and-forget，**回调内的异步工作不会阻塞响应**。这正是官方续传示例必须在异步回调里 `await streamContext.createNewResumableStream(...)` 并依赖 Next.js `after` / `waitUntil` 的原因；在自建服务里你必须自己保证该 Promise 有归属（否则进程可能提前回收）。
- 该函数同时说明：`UI_MESSAGE_STREAM_HEADERS` 由 `prepareHeaders` **自动注入**，无需手写（自建 GET 续传端点时才需手动带上）。

**stop 端点必须自建**，官方要求 4 步（L325-331）：① 读 `activeStreamId`；② 若客户端带了 assistant 快照则持久化该部分回复；③ 取消产出流的工作；④ **仅在 `activeStreamId` 仍指向同一条流时**清空它（防竞态）。客户端须**先打 stop 端点、再 `chat.stop()`**（L314-315）。硬约束（L387-393）：不要把 stop 挂在路由清理/unmount（那些是 disconnect，应保持可续传）；用户 stop 后至其再次发消息前**避免自动重连**。完整代码见 L332-379。

**心跳**：`connection: keep-alive`、`cache-control: no-cache` 由框架写出；官方仅有一句 *"keep-alive through ping"*（`docs:04-ai-sdk-ui/50-stream-protocol.mdx:109`）。**未查到 SDK 内建的定时 ping/注释帧实现**——需穿透代理空闲超时须自行在 `execute` 里发注释帧或心跳 part。

**非 Next.js 自建 HTTP 服务的差异**（`ai/dist:L4321-4324`、`L2448`）：

```ts
declare function pipeUIMessageStreamToResponse({ response, status, statusText, headers, stream, consumeSseStream }: {
  response: ServerResponse;
  stream: ReadableStream<UIMessageChunk>;
} & UIMessageStreamResponseInit): Promise<void>;

// streamText 结果的同类方法
pipeUIMessageStreamToResponse<UI_MESSAGE extends UIMessage>(
  response: ServerResponse,
  options?: UIMessageStreamResponseInit & UIMessageStreamOptions<UI_MESSAGE>
): Promise<void>;
```

| 维度 | Next.js App Router | 自建 Node / Express / NestJS |
| --- | --- | --- |
| 建响应 | `createUIMessageStreamResponse({ stream })` | `pipeUIMessageStreamToResponse({ response, stream })` |
| 后台续跑 | `after()` from `next/server` | 无 `after`，须自建 worker/常驻进程 |
| 端点定义 | 必须保留 `GET {api}/{chatId}/stream` + **204** | 同左，否则 `resume: true` 失效 |
| 反向代理 | `x-accel-buffering: no` 关 nginx 缓冲 | 同样必要 |
| 跨语言后端 | — | 官方允许（`50-stream-protocol.mdx:13-17`），须设 `x-vercel-ai-ui-message-stream: v1` |

自建组装多源流的核心签名（`ai/dist:L4265-4282`、`L4224-4250`）：

```ts
declare function createUIMessageStream<UI_MESSAGE extends UIMessage>({ execute, onError, originalMessages, onStepFinish, onFinish, generateId }: {
  execute: (options: { writer: UIMessageStreamWriterWithOutcome<UI_MESSAGE> }) => Promise<void> | void;
  onError?: (error: unknown) => string;
  /** The original messages. If they are provided, persistence mode is assumed,
   *  and a message ID is provided for the response message. */
  originalMessages?: UI_MESSAGE[];
  onStepFinish?: UIMessageStreamOnStepFinishCallback<UI_MESSAGE>;
  onFinish?: UIMessageStreamOnFinishCallback<UI_MESSAGE>;
  generateId?: IdGenerator;
}): ReadableStream<InferUIMessageChunk<UI_MESSAGE>>;

interface UIMessageStreamWriter<UI_MESSAGE extends UIMessage = UIMessage> {
  write(part: InferUIMessageChunk<UI_MESSAGE>): void;
  merge(stream: ReadableStream<InferUIMessageChunk<UI_MESSAGE>>): void;
  onError: ErrorHandler | undefined;
}
interface UIMessageStreamWriterWithOutcome<UI_MESSAGE extends UIMessage = UIMessage>
  extends UIMessageStreamWriter<UI_MESSAGE> {
  /** 声明整条流的操作级结局；不写 chunk、不关流 */
  setOutcome(outcome: UIMessageStreamOutcome): void;
}
// ai/dist:L2134-2143
type UIMessageStreamOutcome = { status: 'completed' } | { status: 'failed'; error?: unknown }
  | { status: 'aborted' } | { status: 'unknown' };
```

另可用 `readUIMessageStream`（`ai/dist:L4337-4342`）在**服务端**把 chunk 流还原为 UIMessage 快照序列（带 `message` 参数即可从上次的部分消息继续），适合做服务端进度落库。

---

## 6. 用自定义 data part 上报会话状态机

**类型定义（官方原文，`docs:04-ai-sdk-ui/20-streaming-data.mdx:25-43`）**：

```tsx filename="ai/types.ts"
import { UIMessage } from 'ai';

// Define your custom message type with data part schemas
export type MyUIMessage = UIMessage<
  never, // metadata type
  {
    weather: { city: string; weather?: string; status: 'loading' | 'success' };
    notification: { message: string; level: 'info' | 'warning' | 'error' };
  } // data parts type
>;
```

把状态机建模为一个 data part，例如 `runState: { status: 'queued'|'running'|'resuming'|'paused'|'failed'|'completed'; ... }`。

**服务端注入（官方原文，同文件 L49-121）**：

```tsx filename="route.ts"
import { openai } from '@ai-sdk/openai';
import { createUIMessageStream, createUIMessageStreamResponse, streamText, convertToModelMessages } from 'ai';
import type { MyUIMessage } from '@/ai/types';

export async function POST(req: Request) {
  const { messages } = await req.json();

  const stream = createUIMessageStream<MyUIMessage>({
    execute: ({ writer }) => {
      // 1. Send initial status (transient - won't be added to message history)
      writer.write({
        type: 'data-notification',
        data: { message: 'Processing your request...', level: 'info' },
        transient: true, // This part won't be added to message history
      });

      // 2. Send data parts with loading state
      writer.write({
        type: 'data-weather',
        id: 'weather-1',
        data: { city: 'San Francisco', status: 'loading' },
      });

      const result = streamText({
        model: __MODEL__,
        messages: await convertToModelMessages(messages),
        onFinish() {
          // 3. Update the same data part (reconciliation)
          writer.write({
            type: 'data-weather',
            id: 'weather-1', // Same ID = update existing part
            data: { city: 'San Francisco', weather: 'sunny', status: 'success' },
          });

          // 4. Send completion notification (transient)
          writer.write({
            type: 'data-notification',
            data: { message: 'Request completed', level: 'info' },
            transient: true,
          });
        },
      });

      writer.merge(result.toUIMessageStream());
    },
  });

  return createUIMessageStreamResponse({ stream });
}
```

> ⚠️ 官方原文第 2 步还有一段 `writer.write({ type: 'source', value: {...} })`（L73-82）。**那是错误示例**，v6 无此 chunk，详见 7.6。

**两条上报通道**：

| | 持久 data part | transient data part |
| --- | --- | --- |
| 写法 | `writer.write({ type:'data-run', id:'run-1', data:{...} })` | 再加 `transient: true` |
| 落 `message.parts` | **是** | **否** |
| 同 `id` 重写 | **就地更新（reconciliation）** | 无意义（每次都是新事件） |
| 客户端可见 | `message.parts` **且** `onData` | **仅** `onData` |
| 证据 | `docs:…/20-streaming-data.mdx:131-141,184-193`；`ai/src:ui/process-ui-message-stream.ts:900-930` | 同左 |

**推荐映射**：`queued`/`running`/`resuming`/`paused`/`failed`/`completed` 等需持久化、需刷新后还原的状态 → **带固定 `id` 的持久 data part**（刷新后 `resume: true` 接回流，历史 `messages` 已含该 part，状态自动还原）；进度百分比、瞬时 toast、"正在恢复中"提示 → **`transient: true`**，在 `onData` 里 setState。

**客户端消费（官方原文，同文件 L205-221）**：

```tsx filename="page.tsx"
const { messages } = useChat<MyUIMessage>({
  api: '/api/chat',
  onData: dataPart => {
    // Handle all data parts as they arrive (including transient parts)
    console.log('Received data part:', dataPart);

    if (dataPart.type === 'data-weather') {
      console.log('Weather update:', dataPart.data);
    }
    // Handle transient notifications (ONLY available here, not in message.parts)
    if (dataPart.type === 'data-notification') {
      showToast(dataPart.data.message, dataPart.data.level);
    }
  },
});
```

官方强调：*"**Important:** Transient data parts are **only** available through the `onData` callback. They will not appear in the `message.parts` array since they're not added to message history."*（L224）

**与 `messageMetadata` 的分工**（同文件 L350-397）：metadata 适合消息级整体信息（时间戳/模型/token 用量），经 `toUIMessageStreamResponse({ messageMetadata })` 在 `start`/`finish` 下发（`ai/dist:L2211-2219`：*"Called on `start` and `finish` events"*），落到 `message.metadata`；data part 适合动态、可增量 reconcile、可 transient 的任意数据。

```ts
// 官方示例（docs:…/25-message-metadata.mdx:56-75）
return result.toUIMessageStreamResponse({
  originalMessages: messages, // pass this in for type-safe return objects
  messageMetadata: ({ part }) => {
    if (part.type === 'start') { return { createdAt: Date.now(), model: 'your-model-id' }; }
    if (part.type === 'finish') { return { totalTokens: part.totalUsage.totalTokens }; }
  },
});
```

官方 Note：*"To enable type-safe metadata return object in `messageMetadata`, pass in the `originalMessages` parameter typed to your UIMessage type."*（L78-81）

`UIMessageStreamOptions` 全量（`ai/dist:L2198-2250`）：`originalMessages?`、`generateMessageId?`、`onFinish?`、`messageMetadata?`、`sendReasoning?`（默认 **true**）、`sendSources?`（默认 **false**）、`sendFinish?`（默认 true）、`sendStart?`（默认 true）、`onError?`（默认 `() => 'An error occurred.'`，**默认不泄漏服务端错误细节**）。

---

## 7. AI Elements 组件如何消费这些细节

**最重要的横向结论**：8 个核心组件**全部是受控展示组件**——无一 `import { useChat }`，无一读取 `message.parts`（唯一例外是 `conversation` 导出的纯函数 `messagesToMarkdown`），只 `import type` 从 `ai` 取类型。源码中 **完全没有** `source-url`/`source-document`/`data-*`/`file`/`step-start` 字面量。因此 **part → props 的映射完全由你写**。8 个 registry JSON 均**未附最小用法示例**。`response`/`loader`/`actions` 三个端点**不存在**（返回 `{"error":"Component \"X\" not found."}`）；`MessageResponse` 已并入 `message`。

```tsx
// conversation（reg:conversation，依赖 use-stick-to-bottom）
export type ConversationProps = ComponentProps<typeof StickToBottom>;
export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;
export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string; description?: string; icon?: React.ReactNode; };  // 默认 "No messages yet"
export type ConversationScrollButtonProps = ComponentProps<typeof Button>;
export type ConversationDownloadProps = Omit<ComponentProps<typeof Button>, "onClick"> & {
  messages: UIMessage[]; filename?: string;                            // 默认 "conversation.md"
  formatMessage?: (message: UIMessage, index: number) => string; };
export const messagesToMarkdown: (messages: UIMessage[],
  formatMessage?: (m: UIMessage, i: number) => string) => string;

// message（reg:message，12 个组件；依赖 streamdown + @streamdown/{cjk,code,math,mermaid}）
export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"]; };            // 'system' | 'user' | 'assistant'（ai/dist:L1598）
export type MessageContentProps = HTMLAttributes<HTMLDivElement>;   // 无 from，纯骨架
export type MessageActionsProps = ComponentProps<"div">;
export type MessageActionProps  = ComponentProps<typeof Button> & {
  tooltip?: string; label?: string; };   // 默认 variant="ghost" size="icon-sm"
export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number; onBranchChange?: (branchIndex: number) => void; };
export type MessageResponseProps = ComponentProps<typeof Streamdown>;  // 未加自有 prop
export type MessageToolbarProps  = ComponentProps<"div">;

// reasoning（reg:reasoning）—— 运行态组件
export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;                 // 默认 false
  open?: boolean; defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void; duration?: number; };
export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode; };
export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent> & {
  children: string; };                   // 强制 string，交给 Streamdown

// tool（reg:tool）—— 运行态组件
export type ToolPart = ToolUIPart | DynamicToolUIPart;
export type ToolHeaderProps = { title?: string; className?: string } & (
  | { type: ToolUIPart["type"];        state: ToolUIPart["state"];        toolName?: never }
  | { type: DynamicToolUIPart["type"]; state: DynamicToolUIPart["state"]; toolName: string });
export type ToolInputProps  = ComponentProps<"div"> & { input: ToolPart["input"] };
export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"]; errorText: ToolPart["errorText"]; };

// task / sources / context —— 纯结果展示
export type TaskProps        = ComponentProps<typeof Collapsible>;   // defaultOpen = true
export type TaskTriggerProps = ComponentProps<typeof CollapsibleTrigger> & { title: string };
export type SourcesProps        = ComponentProps<"div">;             // 运行时透传给 Collapsible
export type SourcesTriggerProps = ComponentProps<typeof CollapsibleTrigger> & { count: number };
export type SourceProps         = ComponentProps<"a">;               // 固定 target="_blank" rel="noreferrer"
export type ContextProps = ComponentProps<typeof HoverCard> & {
  usedTokens: number; maxTokens: number;                             // 均必填
  usage?: LanguageModelUsage; modelId?: string; };

// confirmation（reg:confirmation）—— 运行态组件
export type ConfirmationProps = ComponentProps<typeof Alert> & {
  approval?: ToolUIPartApproval;   // 可选
  state: ToolUIPart["state"]; };   // 必填
export type ConfirmationTitleProps = ComponentProps<typeof AlertDescription>;
export interface ConfirmationRequestProps  { children?: ReactNode }
export interface ConfirmationAcceptedProps { children?: ReactNode }
export interface ConfirmationRejectedProps { children?: ReactNode }
export type ConfirmationActionsProps = ComponentProps<"div">;
export type ConfirmationActionProps  = ComponentProps<typeof Button>;

// checkpoint / plan / artifact / code-block / terminal / stack-trace / test-results
export type CheckpointProps        = HTMLAttributes<HTMLDivElement>;
export type CheckpointIconProps    = LucideProps;
export type CheckpointTriggerProps = ComponentProps<typeof Button> & { tooltip?: string };
export type PlanProps = ComponentProps<typeof Collapsible> & { isStreaming?: boolean };
export type ArtifactProps = HTMLAttributes<HTMLDivElement>;
export type ArtifactActionProps = ComponentProps<typeof Button> & {
  tooltip?: string; label?: string; icon?: LucideIcon; };
type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string; language: BundledLanguage; showLineNumbers?: boolean; };  // 依赖 shiki
export type TerminalProps = HTMLAttributes<HTMLDivElement> & {
  output: string; isStreaming?: boolean; autoScroll?: boolean; onClear?: () => void; };
export type StackTraceProps = ComponentProps<"div"> & {
  trace: string; open?: boolean; defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onFilePathClick?: (filePath: string, line?: number, column?: number) => void; };
type TestStatus = "passed" | "failed" | "skipped" | "running";
interface TestResultsSummary { passed: number; failed: number; skipped: number;
  total: number; duration?: number; }
export type TestResultsProps = HTMLAttributes<HTMLDivElement> & { summary?: TestResultsSummary };
export type TestSuiteProps = ComponentProps<typeof Collapsible> & {
  name: string; status: TestStatus; };
export interface QueueMessagePart { type: string; text?: string; url?: string;
  filename?: string; mediaType?: string; }
export interface QueueTodo { id: string; title: string; description?: string;
  status?: "pending" | "completed"; }
```

**组件内真实的状态条件渲染（源码原文）**：

```tsx
// tool（reg:tool:L47-55）—— state 七态的意义映射
const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",      // ← 真正的"运行中"
  "input-streaming": "Pending",      // ← 参数还在流
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};
// L83 工具名反推（含 '-' 也能还原）
const derivedName = type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");
// L141 ToolOutput 唯一硬判断
if (!(output || errorText)) { return null; }   // L158: {errorText ? "Error" : "Result"}

// reasoning（reg:reasoning:L69-122,157-165）
const resolvedDefaultOpen = defaultOpen ?? isStreaming;   // L69
const isExplicitlyClosed = defaultOpen === false;         // L71
if (isStreaming && !isOpen && !isExplicitlyClosed) setIsOpen(true);      // L102 自动展开
// L108-122：流结束后 AUTO_CLOSE_DELAY=1000ms 自动收起（仅一次）；L88-98 用 Date.now() 计时
if (isStreaming || duration === 0) return <Shimmer duration={1}>Thinking...</Shimmer>;
if (duration === undefined) return <p>Thought for a few seconds</p>;
return <p>Thought for {duration} seconds</p>;

// confirmation（reg:confirmation:L70,98,115-122,137-144,158）
if (!approval || state === "input-streaming" || state === "input-available") return null;  // L70 根组件短路
if (state !== "approval-requested") return null;                                          // L98 Request
if (state !== "approval-requested") return null;                                          // L158 Actions
if (!approval?.approved || (state !== "approval-responded"
    && state !== "output-denied" && state !== "output-available")) return null;           // L115-122 Accepted
if (approval?.approved !== false || (state !== "approval-responded"
    && state !== "output-denied" && state !== "output-available")) return null;           // L137-144 Rejected

// conversation（reg:conversation:L78,85）—— 流式自动吸底
const { isAtBottom, scrollToBottom } = useStickToBottomContext();
... !isAtBottom && ( /* 回底按钮 */ )

// message/MessageResponse（reg:message:L337-339）—— 运行态经 memo 比较器透传 isAnimating
(prevProps, nextProps) => prevProps.children === nextProps.children
  && nextProps.isAnimating === prevProps.isAnimating

// context（reg:context:L24-29）—— token 字段
interface ContextSchema { usedTokens: number; maxTokens: number;
  usage?: LanguageModelUsage; modelId?: ModelId; }
// 消费：usage?.inputTokens ?? 0 (L259)、outputTokens (L299)、
//       reasoningTokens (L339)、cachedInputTokens (L379)
```

**审批闭环由你接线**：`ConfirmationAction` 只是 `<Button>`，源码内**无任何 `addToolApprovalResponse`/`sendMessage` 调用**。需自行在 onClick 里调用：

```ts
// ai/dist:L3720-3734
type ChatAddToolApproveResponseFunction = ({ id, approved, reason, options }: {
  id: string; approved: boolean; reason?: string; options?: ChatRequestOptions;
}) => void | PromiseLike<void>;
```

配合 `sendAutomaticallyWhen`（`ai/dist:L3835-3837`）与官方导出的 `lastAssistantMessageIsCompleteWithApprovalResponses` 可在审批后自动续跑。

**源码瑕疵（照录）**：`ToolUIPartApproval`（`reg:confirmation:L10-36`，未导出）中 `{ id; approved: true; reason?: string }` 分支**重复两次**；Accepted/Rejected 的 state 白名单不含 `approval-requested`，只校验 `approved`，若请求阶段 `approval.approved` 已有值会提前渲染。`SourcesProps` 声明为 `ComponentProps<"div">` 但运行时透传给 `Collapsible`，类型与运行时不严格一致。

**运行态 vs 结果展示总表**：

| 组件 | 归类 | 运行态信号 | 依据 |
| --- | --- | --- | --- |
| `conversation` | **运行态**（容器） | `isAtBottom` 自动吸底 | L78、L85 |
| `reasoning` | **运行态** | `isStreaming`（自动展开/计时/1s 后收起/Shimmer） | L69-122、L157-165 |
| `tool` | **运行态** | `state` 七态；`input-available`=Running | L47-65、L96、L141 |
| `confirmation` | **运行态** | `state` + `approval.approved` 门控 | L70/98/115-122/137-144/158 |
| `plan` | **运行态** | `isStreaming` → Shimmer | L40、L82、L107 |
| `terminal` | **运行态** | `isStreaming` → 流式光标 | L216、L227-243 |
| `message`(`MessageResponse`) | 边界 | 透传 `isAnimating` 给 Streamdown | L337-339 |
| `task`/`sources`/`context` | 结果展示 | 零状态判断 | — |
| `checkpoint`/`queue`/`artifact`/`code-block`/`stack-trace`/`test-results` | 结果展示 | `test-results` 的 `TestStatus="running"` 是数据字段，非组件内判断 | `test-results` L20 |

依赖：`code-block`→`shiki`；`terminal`→`ansi-to-react`；`context`→`tokenlens`；`message`/`reasoning`→`streamdown` 全家桶；`reasoning`/`plan`→额外 registry `shimmer.json`。

---

## 8. 已知坑

**8.1 工具 part 辅助函数语义反转（v6 最易踩）**（`docs:08-migration-guides/24-migration-guide-6-0.mdx:556-640`）：

| v5 | v6 | 说明 |
| --- | --- | --- |
| `isToolUIPart` | **`isStaticToolUIPart`** | v6 的 `isToolUIPart` 表示"静态**或动态**"，语义**已变** |
| `isToolOrDynamicToolUIPart` | **`isToolUIPart`** | 旧名保留但 `@deprecated` |
| `getToolName` | **`getStaticToolName`** | v6 的 `getToolName` 返回"静态或动态" |
| `getToolOrDynamicToolName` | **`getToolName`** | 旧名 `@deprecated` |

`ai/dist:L1957-1959`、`L1974-1976` 以 `@deprecated` JSDoc 确认旧名保留。**v5 代码里的 `isToolUIPart(part)` 在 v6 编译通过但语义已变**——静默行为变更，最危险。

**8.2 tool `state` 由 4 态扩到 7 态**（`ai/dist:L1737-1819`）。任何 `switch` 穷尽或 `Record<ToolPart["state"], X>` 都必须补 `approval-requested`/`approval-responded`/`output-denied`；用 `satisfies` 或显式 `Record` 会在编译期报错（好事）。

**8.3 `addToolResult` → `addToolOutput`**（`ai/dist:L3913-3914`；`ai/CHANGELOG.md:2308` 位于 6.0.0 段：*"`chat.addToolResult()` is now `chat.addToolOutput()`"*）。新签名支持错误结果 `{ state: 'output-error'; errorText: string }`（`ai/dist:L3755-3759`）。

**8.4 续传 API 改名与分层**：`experimental_resume` → **`resumeStream`** 的改名发生在 **v5.0.0**（`ai/CHANGELOG.md:4118`），v6 沿用；v5 教程里的 `experimental_resume` 已不可用。传输层接口仍叫 `reconnectToStream`（`ai/dist:L3687`）；自定义续传端点用 `prepareReconnectToStreamRequest`（`ai/dist:L4030`）。v5 请求体字段 `id` → v6 `chatId`。

**8.4b 两处文档与实现不符**：① `resumeStream` 官方参考页写 `() => void`，实现是 `Promise<void>`（`ai/dist:L3906`）——**需 `await`**；② `streamText` 的 `consumeSseStream` 官方参考页写 `(stream) => Promise<void>`，实现是 `({ stream })` 且**不 await**（见 §5，本主题最高频踩坑点）。

**8.5 `useChat` 与 React 19 / StrictMode**：官方强制 React 19 最低版本（`@ai-sdk/react@3.0.0` CHANGELOG：*"af65ab6: drop react 19-rc support. Require minimal versions for RSC to address CVE-2025-55182"*）。**未查到**官方专门讨论 StrictMode 双执行的章节（docs 全量 grep 无 StrictMode 命中，请勿采信"官方有该指南"）。源码可确认三项相关机制：① 回调经中间代理转发到 ref，避免闭包过期且不重建实例；② nullish `id` 视同省略，避免每次渲染重建；③ `resume` 的挂载期 GET 有并发去重——`activeResumeRequest` 会 abort 上一个（`ai/src:ui/chat.ts:594-595,624-638`），204 时**不改状态**避免闪烁（L644-661），这实际就是 StrictMode 双挂载"重复 resume"的官方防线。**建议（推断）**：StrictMode 下别自己在 `useEffect` 里调 `resumeStream()`，用 `resume: true` 让 SDK 去重；`onData` 里 setState 保持幂等。

**8.6 官方文档的 `type: 'source'` 示例是错的（v6）**：`docs:04-ai-sdk-ui/20-streaming-data.mdx:73-82` 与 L258-264 给出 `writer.write({ type: 'source', value: {...} })`，但 v6 的 `UIMessageChunk` **只有 `source-url` 与 `source-document`**（`ai/dist:L2089-2100`；`ai/src:ui-message-stream/ui-message-chunks.ts:131,138`），`UIMessagePart` 同理无 `source`；同页 L259 教按 `part.type === 'source'` 过滤渲染也无效。**正确写法**：

```ts
writer.write({ type: 'source-url', sourceId: 'source-1',
  url: 'https://weather.com', title: 'Weather Data Source' });
```

另可复现：`uiMessageChunkSchema()` 在本版本**并未真正拒绝非法 `type`**——实测 `{type:'totally-bogus'}` 亦通过（schema 内 `z.custom<`data-${string}`>` 无法导出 JSON Schema，`node` 实测抛 `Custom types cannot be represented in JSON Schema`）。**不要把该 schema 当可靠的服务端校验器**，它只用于类型推导。

**8.7 流式与 RSC 混用**：`@ai-sdk/rsc` 在 **5.0.0 已拆为独立包**（`ai/CHANGELOG.md:4082`），v6 的 `ai` 不再导出 RSC API。`ai/dist:L1588-1612`：*"System messages should be avoided (set the system prompt on the server instead)."*，且 assistant 消息可含 text/reasoning/tool/file parts——**RSC 首屏不能假设存在 reasoning 或 tool part**。`onError` 默认 `() => 'An error occurred.'`，**服务端错误细节默认不下发**（`ai/dist:L4256`），要展示真实失败原因须显式传 `onError`。**未查到**流式与 RSC 同用的官方专门章节。

**8.8 其他 v6 Core breaking change**（`docs:08-migration-guides/24-migration-guide-6-0.mdx` L83-525）：`Experimental_Agent`→`ToolLoopAgent`、`CoreMessage` 移除→`ModelMessage`、`generateObject`/`streamObject` 弃用、**`convertToModelMessages` 变 async（须 `await`）**、`Tool.toModelOutput` 改为 `{ output }`、`cachedInputTokens`/`reasoningTokens` 弃用（新路径 `outputTokenDetails.reasoningTokens`/`inputTokenDetails.cacheReadTokens`）、`ToolCallOptions`→`ToolExecutionOptions`、Per-Tool Strict Mode、**finish reason `"unknown"` 并入 `"other"`**。包版本需 `ai ^6` / `@ai-sdk/provider ^3` / `provider-utils ^4`，官方提供 `npx @ai-sdk/codemod v6`。**`convertToModelMessages` 变异步**与 **finish reason 合并**最易静默出问题。

---

## 9. 未查到（明确声明，未编造）

1. **SDK 内建 SSE 心跳**：源码无定时 ping/注释帧。
2. **`useChat` 在 React 19 StrictMode 下的官方说明**：docs 无此章节。
3. **AI Elements 组件的最小用法示例**：8 个 registry JSON 无 `@example`/usage 段落。
4. **`Streamdown` 完整 props**：本机未装该包。
5. **`resumable-stream` 包自身 API 与流过期默认值**：无官方文档页，仅确认 `createResumableStreamContext({ waitUntil })`、`createNewResumableStream(id, () => stream)`、`resumeExistingStream(id)`（`docs:…/03-chatbot-resume-streams.mdx:144-145,187`）。
6. **非 Next.js 的续传完整示例**：官方示例依赖 Next 专有 `after`。
7. **v6 针对 `resumeStream`/`reconnectToStream`/`consumeSseStream` 的 breaking change**：迁移指南未提。
8. **AI Elements 与 `data-*` part 的内建对接**：源码无 `data-` 字面量，确认为"无"。
