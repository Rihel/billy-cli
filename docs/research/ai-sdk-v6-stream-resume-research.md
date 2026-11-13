# AI SDK v6 官方文档调研报告：流式 UI 的续传 / 恢复

> **状态：调研快照（写作时点）。** 外部库版本与线上文档会继续演进，本文结论不随本仓库代码更新；
> 当前实现见 [`docs/guide/`](../guide/) 与 [`docs/design/`](../design/)。

> 调研对象：`ai@6.0.289`（v6 官方发布版本）
> 一手材料：npm 包 `ai@6.0.289` tarball 自带的官方文档（`.mdx`），与线上 `https://ai-sdk.dev/docs` 同源同版本；另有 `ai@6.0.289` 的 TypeScript 源码用于核对类型签名。
> 引用格式：**本地文件路径（行号）↔ 对应官方 URL**。
>
> ⚠️ 重要版本说明：截至本次调研，线上 `https://ai-sdk.dev/docs` 已切换到 **v7 (Latest)**。直接抓线上页面会拿到 v7 内容（v7 里 `resume: true` 的 `useChat` 选项仍是主要写法，但参考页行为有差异）。本报告全部结论均取自已确认版本号 `6.0.289` 的本地官方文档，避免 v7 内容混入。

---

## 0. 材料与版本核对

| 项目 | 值 | 依据 |
| --- | --- | --- |
| `ai` 包版本 | `6.0.289` | `/tmp/aiv6/ai/package/package.json`（`npm view ai dist-tags` 中 `ai-v6` 即 `6.0.289`） |
| `resumable-stream` 包 | `2.2.13`，描述 "Library for resuming and following streams in distributed systems"，仓库 `github.com/vercel/resumable-stream` | `npm view resumable-stream` |
| 文档根目录 | `/tmp/aiv6/ai/package/docs/` | 目录树 |

官方文档仅以 **npm 链接** 形式引用 `resumable-stream`，没有为该包单独撰写文档页 → 见第 8 节「未查到」说明。

---

## 1. `useChat` 状态面

**来源**：`docs/07-reference/02-ai-sdk-ui/01-use-chat.mdx` ↔ <https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat>
辅助：`docs/04-ai-sdk-ui/02-chatbot.mdx` ↔ <https://ai-sdk.dev/docs/ai-sdk-ui/chatbot>

### 1.1 `status` 四个取值

参考页原文（`01-use-chat.mdx:397-401`）：

> `status`：`'submitted' | 'streaming' | 'ready' | 'error'`
> The current status of the chat: "ready" (idle), "submitted" (request sent), "streaming" (receiving response), or "error" (request failed).

Guide 页逐条定义原文（`02-chatbot.mdx:112-117`）：

> The `useChat` hook returns a `status`. It has the following possible values:
>
> - `submitted`: The message has been sent to the API and we're awaiting the start of the response stream.
> - `streaming`: The response is actively streaming in from the API, receiving chunks of data.
> - `ready`: The full response has been received and processed; a new user message can be submitted.
> - `error`: An error occurred during the API request, preventing successful completion.

官方配套用过（`02-chatbot.mdx:151-158`、`290`、`305`）：

```tsx
{(status === 'submitted' || status === 'streaming') && (
  <div>
    {status === 'submitted' && <Spinner />}
    <button type="button" onClick={() => stop()}>
      Stop
    </button>
  </div>
)}
```

### 1.2 `error`

参考页原文（`01-use-chat.mdx:402-406`）：

> `error`：`Error | undefined`
> The error object if an error occurred.

Guide 页原文（`02-chatbot.mdx:186-187`）：

> Similarly, the `error` state reflects the error object thrown during the fetch request. It can be used to display an error message, disable the submit button, or show a retry button

同时提供 `clearError`（`01-use-chat.mdx:452-456`）：

> `clearError`：`() => void` —— Clears the error state.

### 1.3 `stop()`

参考页原文（`01-use-chat.mdx:446-451`）：

> `stop`：`() => void`
> Function to abort the current streaming response from the assistant.

⚠️ 关键语义（续传场景下 `stop()` 只是断开连接，不是取消服务端生成）见第 6 节。

### 1.4 `regenerate()`

参考页原文（`01-use-chat.mdx:440-445`）：

> `regenerate`：`(options?: { messageId?: string } & ChatRequestOptions) => Promise<void>`
> Function to regenerate the last assistant message or a specific message. If no messageId is provided, regenerates the last assistant message. Accepts ChatRequestOptions for headers, body, and metadata.

### 1.5 `resumeStream()` 与 `reconnectToStream()` 的关系（重点）

**结论：v6 里两者都存在，但处于不同层，不是同一名字的两种叫法。**

**(a) 公开 Hook API 叫 `resumeStream()`**（`01-use-chat.mdx:457-462`）：

> `resumeStream`：`() => void`
> Function to resume an interrupted streaming response. Useful when a network error occurs during streaming.

> 注：文档标注返回类型为 `() => void`，但源码实现是 async（见下），实际返回 Promise。这里是文档类型标注与实现的差异，官方参考页未给出 `Promise<void>`。

**(b) 传输层接口方法叫 `reconnectToStream()`**，定义在 `ChatTransport` 接口（源码 `/tmp/aiv6/ai/package/src/ui/chat-transport.ts`，对应官方仓库 `packages/ai/src/ui/chat-transport.ts`）：

```ts
  /**
   * Reconnects to an existing streaming response for the specified chat session.
   * ...
   * @returns Promise resolving to:
   *   - `ReadableStream<UIMessageChunk>`: If an active stream is found and can be resumed
   *   - `null`: If no active stream exists for the specified chat session (e.g., response already completed)
   *
   * @throws Error when the reconnection request fails or response is invalid
   */
  reconnectToStream: (
    options: {
      /** Unique identifier for the chat session to reconnect to */
      chatId: string;
      /** Signal to abort the reconnection request if needed */
      abortSignal?: AbortSignal;
    } & ChatRequestOptions,
  ) => Promise<ReadableStream<UIMessageChunk> | null>;
```

**(c) 两者的调用关系**：`resumeStream()` 是 `reconnectToStream()` 的客户端入口。源码 `/tmp/aiv6/ai/package/src/ui/chat.ts:470-471` 与 `613-671`：

```ts
  resumeStream = async (options: ChatRequestOptions = {}): Promise<void> => {
    await this.makeRequest({ trigger: 'resume-stream', ...options });
  };
```

```ts
  private async makeRequest({
    trigger,
    metadata,
    headers,
    body,
    messageId,
  }: {
    trigger: 'submit-message' | 'resume-stream' | 'regenerate-message';
    messageId?: string;
  } & ChatRequestOptions) {
    // ...
    // For resume-stream, check if there's an active stream before
    // changing status. This avoids a brief flash of 'submitted' status
    // when there is no stream to resume (e.g. on page load).
    let resumeStream: ReadableStream<UIMessageChunk> | undefined;
    if (trigger === 'resume-stream') {
      try {
        const reconnect = await this.transport.reconnectToStream({
          chatId: this.id,
          abortSignal: abortController.signal,
          metadata,
          headers,
          body,
        });

        if (abortController.signal.aborted || !isCurrentRequest()) {
          await reconnect?.cancel().catch(() => {});
          if (isCurrentRequest()) {
            this.setStatus({ status: 'ready' });
          }
          clearActiveResumeRequest();
          return;
        }

        if (reconnect == null) {
          this.setStatus({ status: 'ready' });
          clearActiveResumeRequest();
          return; // no active stream found, so we do not resume
        }

        resumeStream = reconnect;
```

即：调用 `resumeStream()` → `makeRequest({ trigger: 'resume-stream' })` → `transport.reconnectToStream(...)`；若返回 `null`（服务端无活动流）则直接回到 `ready`，不改变消息。

**(d) 历史沿革**（`docs/08-migration-guides/26-migration-guide-5-0.mdx:1708-1720` ↔ <https://ai-sdk.dev/docs/migration-guides/migration-guide-5-0>）：

> The resume functionality has been moved from `experimental_resume` to `resumeStream`.

（v4 `experimental_resume: true` → v5 起 `resumeStream`）

**(e) v6 里 `useChat` 的 `resume` 选项**（`01-use-chat.mdx:343-349`）：

> `resume`：`boolean`，optional
> Whether to resume an ongoing chat generation stream. Defaults to false.

即 v6 同时提供：**自动**（`resume: true`，挂载时自动重连）与**手动**（调用 `resumeStream()`）。

### 1.6 回调签名原文

全部出自 `01-use-chat.mdx`：

`onToolCall`（`:261-267`）：

> `onToolCall`：`({toolCall: ToolCall}) => void | Promise<void>`
> Optional callback function that is invoked when a tool call is received. You must call addToolOutput to provide the tool result.

`onFinish`（`:275-321`）：

> `onFinish`：`(options: OnFinishOptions) => void`
> Called when the assistant response has finished streaming.

`OnFinishOptions` 参数原文：

> - `message`：`UIMessage` —— The response message.
> - `messages`：`UIMessage[]` —— All messages including the response message
> - `isAbort`：`boolean` —— True when the request has been aborted by the client.
> - `isDisconnect`：`boolean` —— True if the server has been disconnected, e.g. because of a network error.
> - `isError`：`boolean` —— True if errors during streaming caused the response to stop early.
> - `finishReason`：`'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'`，optional —— The reason why the model finished generating the response. Undefined if the finish reason was not provided by the model.

`onError`（`:322-328`）：

> `onError`：`(error: Error) => void`
> Callback function to be called when an error is encountered.

`onData`（`:329-335`）：

> `onData`：`(dataPart: DataUIPart) => void`
> Optional callback function that is called when a data part is received.

`experimental_throttle`（`:336-342`）：

> `experimental_throttle`：`number`，optional
> Custom throttle wait in ms for the chat messages and data updates. Default is undefined, which disables throttling.

`sendAutomaticallyWhen`（`:268-274`）：

> `sendAutomaticallyWhen`：`(options: { messages: UIMessage[] }) => boolean | PromiseLike<boolean>`
> When provided, this function will be called when the stream is finished or a tool call is added to determine if the current messages should be resubmitted. You can use the lastAssistantMessageIsCompleteWithToolCalls helper for common scenarios.

Guide 页的用法示例原文（`02-chatbot.mdx:340-358`）：

```tsx
import { UIMessage } from 'ai';

const {
  /* ... */
} = useChat({
  onFinish: ({ message, messages, isAbort, isDisconnect, isError }) => {
    // use information to e.g. update other UI states
  },
  onError: error => {
    console.error('An error occurred:', error);
  },
  onData: data => {
    console.log('Received data part from server:', data);
  },
});
```

> It's worth noting that you can abort the processing by throwing an error in the `onData` callback. This will trigger the `onError` callback and stop the message from being appended to the chat UI. This can be useful for handling unexpected responses from the AI provider.

`experimental_throttle` 用法（`02-chatbot.mdx:320-328`）：

> By default, the `useChat` hook will trigger a render every time a new chunk is received. You can throttle the UI updates with the `experimental_throttle` option.

```tsx filename="page.tsx" highlight="2-3"
const { messages, ... } = useChat({
  // Throttle the messages and data updates to 50ms:
  experimental_throttle: 50
})
```

### 1.7 `sendMessage` 的 `body` / `headers` / `metadata`

参考页原文（`01-use-chat.mdx:407-439`）：

> `sendMessage`：`(message?: { text: string; files?: FileList | FileUIPart[]; metadata?; messageId?: string } | CreateUIMessage, options?: ChatRequestOptions) => Promise<void>`
> Function to send a new message to the chat. This will trigger an API call to generate the assistant response. If a messageId is provided, the message will be replaced (useful for editing). If no message is provided, resubmits the current messages (useful after adding tool outputs).

`ChatRequestOptions` 参数原文：

> - `headers`：`Record<string, string> | Headers`，optional —— Additional headers that should be to be passed to the API endpoint.
> - `body`：`object`，optional —— Additional body JSON properties that should be sent to the API endpoint.
> - `metadata`：`unknown`，optional —— Additional data to be sent to the API endpoint.

逐请求设置 body 的官方示例（`02-chatbot.mdx:480-487`）：

```tsx
sendMessage(
  { text: input },
  {
    body: {
      customKey: 'customValue',
    },
  },
);
```

---

## 2. 页面刷新 / 断线后接回正在进行的 run

**来源**：`docs/04-ai-sdk-ui/03-chatbot-resume-streams.mdx` ↔ <https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams>

### 2.1 官方定性：谁提供什么

原文（`03-chatbot-resume-streams.mdx:8`）：

> `useChat` supports resuming ongoing streams after page reloads. Use this feature to build applications with long-running generations.

原文（`:21-36`）：

> Stream resumption requires persistence for messages and active streams in your application. The AI SDK provides tools to connect to storage, but you need to set up the storage yourself.
>
> **The AI SDK provides:**
>
> - A `resume` option in `useChat` that automatically reconnects to active streams
> - Access to the outgoing stream through the `consumeSseStream` callback
> - Automatic HTTP requests to your resume endpoints
>
> **You build:**
>
> - Storage to track which stream belongs to each chat
> - Redis to store the UIMessage stream
> - Two API endpoints: POST to create streams, GET to resume them
> - Integration with [`resumable-stream`](https://www.npmjs.com/package/resumable-stream) to manage Redis storage

前置条件原文（`:38-44`）：

> To implement resumable streams in your chat application, you need:
>
> 1. **The `resumable-stream` package** - Handles the publisher/subscriber mechanism for streams
> 2. **A Redis instance** - Stores stream data (e.g. [Redis through Vercel](https://vercel.com/marketplace/redis))
> 3. **A persistence layer** - Tracks which stream ID is active for each chat (e.g. database)

### 2.2 客户端原文（Next.js client）

`03-chatbot-resume-streams.mdx:48-91`，原文代码：

```tsx filename="app/chat/[chatId]/chat.tsx"
'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';

export function Chat({
  chatData,
  resume = false,
}: {
  chatData: { id: string; messages: UIMessage[] };
  resume?: boolean;
}) {
  const { messages, sendMessage, status } = useChat({
    id: chatData.id,
    messages: chatData.messages,
    resume, // Enable automatic stream resumption
    transport: new DefaultChatTransport({
      // You must send the id of the chat
      prepareSendMessagesRequest: ({ id, messages }) => {
        return {
          body: {
            id,
            message: messages[messages.length - 1],
          },
        };
      },
    }),
  });

  return <div>{/* Your chat UI */}</div>;
}
```

原文补充（`:86-91`）：

> You must send the chat ID with each request (see `prepareSendMessagesRequest`).
>
> When you enable `resume`, the `useChat` hook makes a `GET` request to `/api/chat/[id]/stream` on mount to check for and resume any active streams.

### 2.3 服务端 POST handler 原文

`03-chatbot-resume-streams.mdx:95-152`，原文代码：

```ts filename="app/api/chat/route.ts"
import { openai } from '@ai-sdk/openai';
import { readChat, saveChat } from '@util/chat-store';
import {
  convertToModelMessages,
  generateId,
  streamText,
  type UIMessage,
} from 'ai';
import { after } from 'next/server';
import { createResumableStreamContext } from 'resumable-stream';

export async function POST(req: Request) {
  const {
    message,
    id,
  }: {
    message: UIMessage | undefined;
    id: string;
  } = await req.json();

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

### 2.4 服务端 GET handler 原文（含 204 语义）

`03-chatbot-resume-streams.mdx:154-198`，原文代码：

```ts filename="app/api/chat/[id]/stream/route.ts"
import { readChat } from '@util/chat-store';
import { UI_MESSAGE_STREAM_HEADERS } from 'ai';
import { after } from 'next/server';
import { createResumableStreamContext } from 'resumable-stream';

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const chat = await readChat(id);

  if (chat.activeStreamId == null) {
    // no content response when there is no active stream
    return new Response(null, { status: 204 });
  }

  const streamContext = createResumableStreamContext({
    waitUntil: after,
  });

  return new Response(
    await streamContext.resumeExistingStream(chat.activeStreamId),
    { headers: UI_MESSAGE_STREAM_HEADERS },
  );
}
```

**204 语义**（原文 `:156-161` 与 `:399`）：

> Create a GET handler at `/api/chat/[id]/stream` that:
>
> 1. Reads the chat ID from the route params
> 2. Loads the chat data to check for an active stream
> 3. Returns 204 (No Content) if no stream is active
> 4. Resumes the existing stream if one is found

> **Error handling**: When no active stream exists, the GET handler returns a 204 (No Content) status code

客户端行为已由源码证实：`HttpChatTransport.reconnectToStream()` 收到 `204` 时返回 `null`（`/tmp/aiv6/ai/package/src/ui/http-chat-transport.ts:253-256`）：

```ts
    // no active stream found, so we do not resume
    if (response.status === 204) {
      return null;
    }
```

`after` 的作用（原文 `:193-198`）：

> The `after` function from Next.js allows work to continue after the response has been sent. This ensures that the resumable stream persists in Redis even after the initial response is returned to the client, enabling reconnection later.

### 2.5 完整请求生命周期（原文 `:200-212`）

> 1. **Stream creation**: When you send a new message, the POST handler uses `streamText` to generate the response. The `consumeSseStream` callback creates a resumable stream with a unique ID and stores it in Redis through the `resumable-stream` package
> 2. **Stream tracking**: Your persistence layer saves the `activeStreamId` in the chat data
> 3. **Client reconnection**: When the client reconnects (page reload), the `resume` option triggers a GET request to `/api/chat/[id]/stream`
> 4. **Stream recovery**: The GET handler checks for an `activeStreamId` and uses `resumeExistingStream` to reconnect. If no active stream exists, it returns a 204 (No Content) response
> 5. **Completion cleanup**: When the stream finishes, the `onFinish` callback clears the `activeStreamId` by setting it to `null`

### 2.6 自定义 resume 端点 `prepareReconnectToStreamRequest` 原文

`03-chatbot-resume-streams.mdx:214-247`：

> By default, the `useChat` hook makes a GET request to `/api/chat/[id]/stream` when resuming. Customize this endpoint, credentials, and headers, using the `prepareReconnectToStreamRequest` option in `DefaultChatTransport`:

```tsx filename="app/chat/[chatId]/chat.tsx"
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

export function Chat({ chatData, resume }) {
  const { messages, sendMessage } = useChat({
    id: chatData.id,
    messages: chatData.messages,
    resume,
    transport: new DefaultChatTransport({
      // Customize reconnect settings (optional)
      prepareReconnectToStreamRequest: ({ id }) => {
        return {
          api: `/api/chat/${id}/stream`, // Default pattern
          // Or use a different pattern:
          // api: `/api/streams/${id}/resume`,
          // api: `/api/resume-chat?id=${id}`,
          credentials: 'include', // Include cookies/auth
          headers: {
            Authorization: 'Bearer token',
            'X-Custom-Header': 'value',
          },
        };
      },
    }),
  });

  return <div>{/* Your chat UI */}</div>;
}
```

`prepareReconnectToStreamRequest` 的 options 字段（`01-use-chat.mdx:169-213`）：`id`（chat ID）、`requestMetadata`、`body`、`credentials`、`headers`、`api`。

### 2.7 能否不重跑已产出部分？

**官方没有一句「不重跑」的原文**；可确证的官方措辞是「**reconnect to an active stream**」「keep the stream running」「stream recovery」——即服务端把流写入 Redis，客户端**重连同一个流**（而不是重新发起一次生成）。相关原文（`03-chatbot-resume-streams.mdx:259-261`）：

> Stream resumption lets a client reconnect to an active stream after the original connection closes. To make that possible, the server keeps the stream running even when no client is actively consuming it. If the user refreshes the page, closes the tab, loses their connection, or navigates away, the client can reconnect later with `resumeStream()`.

以及 `:397-398`：

> - **Stream expiration**: Streams in Redis expire after a set time (configurable in the `resumable-stream` package)
> - **Multiple clients**: Multiple clients can connect to the same stream simultaneously

> 结论：官方文档未明确承诺「不重跑模型」；它承诺的是「重连到同一条已存在的流」。是否真的不重跑，取决于 `resumable-stream` 的 Redis 缓冲语义（官方文档未展开，见第 8 节）。

### 2.8 其它注意事项原文（`:395-401`）

> - **Stream expiration**: Streams in Redis expire after a set time (configurable in the `resumable-stream` package)
> - **Multiple clients**: Multiple clients can connect to the same stream simultaneously
> - **Error handling**: When no active stream exists, the GET handler returns a 204 (No Content) status code
> - **Security**: Ensure proper authentication and authorization for both creating and resuming streams
> - **Race conditions**: Clear the `activeStreamId` when starting a new stream to prevent resuming outdated streams

---

## 3. 可续传流场景下的 `stop()` 语义（关键坑）

**来源**：`docs/04-ai-sdk-ui/03-chatbot-resume-streams.mdx` + `docs/09-troubleshooting/15-abort-breaks-resumable-streams.mdx` ↔ <https://ai-sdk.dev/docs/troubleshooting/abort-breaks-resumable-streams>

### 3.1 官方警告原文（`03-chatbot-resume-streams.mdx:10-19`）

> In a resumable stream setup, client-side aborts are treated as disconnects. Closing a tab, refreshing the page, or calling `stop()` only closes the current HTTP connection and should not cancel the underlying generation. To let users stop generation, add a dedicated stop endpoint that persists the partial response, cancels the active work, and clears the active stream.

### 3.2 更完整结论（`:255-265`）

> `useChat` includes a `stop()` function that aborts the current client request. In a resumable stream setup, that abort is a disconnect signal, not a request to stop generation.
>
> Because of this, a client-side abort (e.g. closing the page or refreshing) only closes the current HTTP connection. It is not a request to cancel the underlying work. If your stop button only calls `stop()`, the model request, background job, workflow, or stream writer can continue running, and the client can reconnect to the same active stream.
>
> To support an explicit stop button, create a dedicated stop endpoint. The endpoint should accept the current assistant message from the client, persist that partial response, cancel the work that is producing the stream, and clear the active stream record for the chat.
>
> Stream resumption also needs your application to store a reference from the chat to the stream that can be resumed. This guide calls that reference `activeStreamId`. The resume endpoint uses it to find the stream to reconnect to. The stop endpoint uses the same value to find the work to cancel, and to avoid clearing a newer stream that may have started while the stop request was in flight.

### 3.3 客户端 stop 原文（`:273-321`）

```tsx filename="app/chat/[chatId]/chat.tsx"
'use client';

import { useChat } from '@ai-sdk/react';
import { type UIMessage } from 'ai';

export function Chat({
  chatData,
  resume = false,
}: {
  chatData: {
    id: string;
    messages: UIMessage[];
    activeStreamId?: string | null;
  };
  resume?: boolean;
}) {
  const chat = useChat({
    id: chatData.id,
    messages: chatData.messages,
    resume,
  });

  const stop = () => {
    const lastMessage = chat.messages[chat.messages.length - 1];
    const assistantMessage =
      lastMessage?.role === 'assistant' ? lastMessage : undefined;

    void fetch(`/api/chat/${chatData.id}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        assistantMessage || chatData.activeStreamId
          ? {
              assistantMessage,
              activeStreamId: chatData.activeStreamId,
            }
          : {},
      ),
    });

    void chat.stop();
  };

  return <button onClick={stop}>Stop</button>;
}
```

### 3.4 服务端 stop 端点原文（`:332-379`）

```ts filename="app/api/chat/[id]/stop/route.ts"
import { readChat, saveChat } from '@util/chat-store';
import { type UIMessage } from 'ai';

type StopRequest = {
  activeStreamId?: string | null;
  assistantMessage?: UIMessage;
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const chat = await readChat(id);

  if (chat.activeStreamId == null) {
    return Response.json({ success: true });
  }

  const activeStreamId = chat.activeStreamId;
  const body = (await req.json().catch(() => ({}))) as StopRequest;

  if (
    body.activeStreamId != null &&
    body.activeStreamId !== activeStreamId
  ) {
    return Response.json({ success: true });
  }

  if (body.assistantMessage) {
    await saveAssistantSnapshot({
      chatId: id,
      message: body.assistantMessage,
    });
  }

  await markStreamAsStopped(activeStreamId);
  await cancelActiveWork(activeStreamId);

  const latestChat = await readChat(id);
  if (latestChat.activeStreamId === activeStreamId) {
    await saveChat({ id, activeStreamId: null });
  }

  return Response.json({ success: true });
}
```

原文说明（`:381-393`）：

> `markStreamAsStopped` and `cancelActiveWork` depend on your backend. In a Redis-backed resumable stream setup, you might close the stored stream and abort the model request that is writing to it. In a workflow setup, you might cancel the workflow run that owns the stream. In a job queue setup, you might cancel the job or write a cancellation flag that the job checks.
>
> The `activeStreamId` can identify replay state, producer state, or both. If those are separate in your system, store enough information with the chat to cancel the producer that writes to the stream.
>
> Persist the assistant snapshot as an insert or merge. Avoid overwriting a newer server-written message with an older client snapshot.
>
> **Keep navigation separate from stop**: Do not call the stop endpoint from route cleanup code. Route cleanup is a disconnect, not an explicit stop. The active stream should remain resumable when the user refreshes the page or navigates away.
>
> Only call the stop endpoint for an explicit user action, such as pressing a stop button.
>
> After a user stops a stream, avoid automatic reconnect attempts for that chat until the user sends another message or explicitly retries. Otherwise the client can reconnect before cancellation has finished.

### 3.5 troubleshooting 页结论（`15-abort-breaks-resumable-streams.mdx:8-64`）

> When using `useChat` with `resume: true` for stream resumption, client-side aborts are treated as disconnects. Closing a tab, refreshing the page, navigating away, or calling `stop()` closes the current HTTP connection, but it should not cancel the underlying generation.
>
> If your application passes the request abort signal through to the model call, disconnects can cancel the work that stream resumption expects to keep running. If your stop button only calls `stop()`, the server-side generation can continue and the client may reconnect to the same active stream.

官方 Solution 段原文：

> Use `resume: true` for reconnecting after disconnects, and add a dedicated stop endpoint for explicit user cancellation.
>
> The stop endpoint should:
>
> 1. Load the chat and read its active stream ID
> 2. Persist the latest partial assistant message if the client sends one
> 3. Cancel the work that is producing the stream
> 4. Clear the active stream reference only if it still points to the same stream

```tsx
const chat = useChat({
  id: chatId,
  resume: true,
});

async function stopStream() {
  await fetch(`/api/chat/${chatId}/stop`, { method: 'POST' });
  chat.stop();
}
```

> Keep navigation separate from stop behavior. Do not call the stop endpoint from route cleanup code, page unload handlers, or component unmount cleanup. Those events are disconnects that should remain resumable.
>
> If you do not need stream resumption and only want client-side cancellation, disable `resume` and use `stop()` directly:

```tsx
const { messages, sendMessage, stop } = useChat({
  id: chatId,
  resume: false, // Disable stream resumption (default behavior)
});
```

---

## 4. 响应头约定与 SSE 线格式

**来源**：`docs/04-ai-sdk-ui/50-stream-protocol.mdx` ↔ <https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol>

### 4.1 `UI_MESSAGE_STREAM_HEADERS` 实际值

文档只提到自定义后端需设置 `x-vercel-ai-ui-message-stream: v1`（`:111-114`）：

> When you provide data streams from a custom backend, you need to set the `x-vercel-ai-ui-message-stream` header to `v1`.

完整 5 个响应头来自 v6 源码（`/tmp/aiv6/ai/package/src/ui-message-stream/ui-message-stream-headers.ts:1-7`，对应官方仓库同路径）：

```ts
export const UI_MESSAGE_STREAM_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no', // disable nginx buffering
};
```

该常量在 v6 中导出（`src/ui-message-stream/index.ts:11`：`export { UI_MESSAGE_STREAM_HEADERS } from './ui-message-stream-headers';`），并在 `createUIMessageStreamResponse` 与 `pipeUIMessageStreamToResponse` 内部与用户 headers 合并（`create-ui-message-stream-response.ts:42`：`headers: prepareHeaders(headers, UI_MESSAGE_STREAM_HEADERS)`）。

> 注：官方 docs 的 `createUIMessageStreamResponse` 参考页只列出 `status` / `statusText` / `headers` / `consumeSseStream` 参数，**没有**逐条列出这 5 个默认响应头；逐条值需从源码确认（这也是第 3 节用户点名要的「官方原文」，但 docs 侧只能给到 `x-vercel-ai-ui-message-stream: v1` 这一条）。

### 4.2 SSE 线格式与 `[DONE]` 终止符

原文（`:107-109`）：

> A data stream follows a special protocol that the AI SDK provides to send information to the frontend.
>
> The data stream protocol uses Server-Sent Events (SSE) format for improved standardization, keep-alive through ping, reconnect capabilities, and better cache handling.

每个 part 均为「Server-Sent Event with JSON object」，格式 `data: {json}`（原文逐节标注 "Format: Server-Sent Event with JSON object"）。示例原文：

| Part | 原文示例（`50-stream-protocol.mdx`） |
| --- | --- |
| Message Start | `data: {"type":"start","messageId":"..."}`（`:127`） |
| Text Start | `data: {"type":"text-start","id":"msg_68679a..."}`（`:144`） |
| Text Delta | `data: {"type":"text-delta","id":"msg_68679a...","delta":"Hello"}`（`:157`） |
| Text End | `data: {"type":"text-end","id":"msg_68679a..."}`（`:170`） |
| Reasoning Start/Delta/End | `data: {"type":"reasoning-start","id":"reasoning_123"}` / `...reasoning-delta...delta:"This is some reasoning"` / `...reasoning-end...`（`:187,200,213`） |
| Source URL | `data: {"type":"source-url","sourceId":"https://example.com","url":"https://example.com"}`（`:230`） |
| Source Document | `data: {"type":"source-document","sourceId":"https://example.com","mediaType":"file","title":"Title"}`（`:243`） |
| File | `data: {"type":"file","url":"https://example.com/file.png","mediaType":"image/png"}`（`:256`） |
| Data Parts | `data: {"type":"data-weather","data":{"location":"SF","temperature":100}}`（`:269`） |
| Error | `data: {"type":"error","errorText":"error message"}`（`:284`） |
| Tool Input Start | `data: {"type":"tool-input-start","toolCallId":"call_fJdQDqnXeGxTmr4E3YPSR7Ar","toolName":"getWeatherInformation"}`（`:297`） |
| Tool Input Delta | `data: {"type":"tool-input-delta","toolCallId":"call_fJ...","inputTextDelta":"San Francisco"}`（`:310`） |
| Tool Input Available | `data: {"type":"tool-input-available","toolCallId":"call_fJ...","toolName":"getWeatherInformation","input":{"city":"San Francisco"}}`（`:323`） |
| Tool Approval Request | `data: {"type":"tool-approval-request","toolCallId":"call_fJ...","approvalId":"approval_123","approvalDescriptor":{"scope":"account:delete"}}`（`:336`） |
| Tool Output Available | `data: {"type":"tool-output-available","toolCallId":"call_fJ...","output":{"city":"San Francisco","weather":"sunny"}}`（`:354`） |
| Start Step | `data: {"type":"start-step"}`（`:367`） |
| Finish Step | `data: {"type":"finish-step"}`（`:382`） |
| Finish Message | `data: {"type":"finish"}`（`:395`） |
| Abort | `data: {"type":"abort","reason":"user cancelled"}`（`:408`） |

**`[DONE]` 终止符存在**（`:412-423`）：

> ### Stream Termination
>
> The stream ends with a special `[DONE]` marker.
>
> Format: Server-Sent Event with literal `[DONE]`
>
> Example:
>
> ```
> data: [DONE]
> ```

协议支持范围（`:425-429`）：

> The data stream protocol is supported by `useChat` and `useCompletion` on the frontend and used by default. `useCompletion` only supports the `text` and `data` stream parts.
>
> On the backend, you can use `toUIMessageStreamResponse()` from the `streamText` result object to return a streaming HTTP response.

---

## 5. 服务端续传实现要求

### 5.1 `createUIMessageStreamResponse` 的 `consumeSseStream`

**来源**：`docs/07-reference/02-ai-sdk-ui/41-create-ui-message-stream-response.mdx` ↔ <https://ai-sdk.dev/docs/reference/ai-sdk-ui/create-ui-message-stream-response>

签名原文：

> `consumeSseStream`：`(options: { stream: ReadableStream<string> }) => PromiseLike<void> | void`，optional
> Optional callback to consume the Server-Sent Events stream.

其它参数原文：

> - `stream`：`ReadableStream<UIMessageChunk>` —— The UI message stream to send to the client.
> - `status`：`number`，optional —— The status code for the response. Defaults to 200.
> - `statusText`：`string`，optional —— The status text for the response.
> - `headers`：`Headers | Record<string, string>`，optional —— Additional headers for the response.

### 5.2 `streamText().toUIMessageStreamResponse()` 的 `onFinish` 与 `consumeSseStream`

**来源**：`docs/07-reference/01-ai-sdk-core/02-stream-text.mdx` ↔ <https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text>

`toUIMessageStreamResponse` 在 `streamText` 结果对象上的签名原文（`:3637-3642`）：

> `toUIMessageStreamResponse`：`(options?: ResponseInit & UIMessageStreamOptions) => Response`
> Converts the result to a streamed response object with a UI message stream.

`UIMessageStreamOptions.consumeSseStream` 原文（`:3564-3570`）：

> `consumeSseStream`：`(stream: ReadableStream) => Promise<void>`，optional
> Function to consume the SSE stream. Required for proper abort handling in UI message streams. Use the `consumeStream` function from the AI SDK.

`onFinish` 的保存用途官方示例（`docs/04-ai-sdk-ui/03-chatbot-message-persistence.mdx:370-391` ↔ <https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence>）：

```tsx filename="app/api/chat/route.ts" highlight="7-11"
import { createIdGenerator, streamText } from 'ai';

export async function POST(req: Request) {
  // ...
  const result = streamText({
    // ...
  });

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    // Generate consistent server-side IDs for persistence:
    generateMessageId: createIdGenerator({
      prefix: 'msg',
      size: 16,
    }),
    onFinish: ({ messages }) => {
      saveChat({ chatId, messages });
    },
  });
}
```

> ⚠️ 注意 `consumeSseStream` 有两种形态，不要混淆：
> - `toUIMessageStreamResponse` / `streamText` 侧：`(stream: ReadableStream) => Promise<void>`（用于 abort 正确处理 / 触发 `onFinish`）；
> - `createUIMessageStreamResponse` / `pipeUIMessageStreamToResponse` 侧：`({ stream }: { stream: ReadableStream<string> }) => ...`（对象解构，用于把 SSE 流交给 `resumable-stream`）。续传示例用的是后者。

### 5.3 `messageId` / `generateMessageId` 的作用

**来源**：`docs/04-ai-sdk-ui/03-chatbot-message-persistence.mdx:335-449` ↔ <https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence>

原文（`:340-356`）：

> ### Client-side vs Server-side ID Generation
>
> By default, message IDs are generated client-side:
>
> - User message IDs are generated by the `useChat` hook on the client
> - AI response message IDs are generated by `streamText` on the server
>
> For applications without persistence, client-side ID generation works perfectly. However, **for persistence, you should use IDs that are stable before messages are stored** to ensure consistency across sessions and prevent ID conflicts when messages are restored.
>
> The server-side options below control IDs for generated assistant response messages. User message IDs are created by `useChat` before the request is sent to your API route, so keep those client-generated IDs when saving incoming request messages, or generate and persist your own user message IDs before sending/storing them.

两种服务端 ID 生成方案原文（`:360-431`）：`generateMessageId`（见 5.2）或 `createUIMessageStream` 中手写 `start` part：

```tsx filename="app/api/chat/route.ts" highlight="8-18"
import {
  generateId,
  streamText,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from 'ai';

export async function POST(req: Request) {
  const { messages, chatId } = await req.json();

  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      // Write start message part with custom ID
      writer.write({
        type: 'start',
        messageId: generateId(), // Generate server-side ID for persistence
      });

      const result = streamText({
        model: 'openai/gpt-5-mini',
        messages: await convertToModelMessages(messages),
      });

      writer.merge(result.toUIMessageStream({ sendStart: false })); // omit start message part
    },
    originalMessages: messages,
    onFinish: ({ responseMessage }) => {
      // save your chat here
    },
  });

  return createUIMessageStreamResponse({ stream });
}
```

> 在续传上下文里 `messageId` 的作用：官方续传示例中 `generateMessageId: generateId` 被传给 `toUIMessageStreamResponse`，即让**服务端稳定生成 assistant 消息 ID**，从而「restore / 重连后仍是同一条消息」。官方对 `messageId` 的专门论述仅在「Message IDs / persistence」章节，**没有**一句把 `messageId` 直接与断线重连绑定的原文——这点属于从两处官方材料推出的合理结论，报告如实标注。

### 5.4 客户端断开时的 `consumeStream`（不依赖 Redis 的兜底方案）

**来源**：`docs/04-ai-sdk-ui/03-chatbot-message-persistence.mdx:513-561` ↔ <https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence>

原文（`:515-524`）：

> By default, the AI SDK `streamText` function uses backpressure to the language model provider to prevent the consumption of tokens that are not yet requested.
>
> However, this means that when the client disconnects, e.g. by closing the browser tab or because of a network issue, the stream from the LLM will be aborted and the conversation may end up in a broken state.
>
> Assuming that you have a storage solution in place, you can use the `consumeStream` method to consume the stream on the backend, and then save the result as usual. `consumeStream` effectively removes the backpressure, meaning that the result is stored even when the client has already disconnected.

```tsx filename="app/api/chat/route.ts" highlight="19-21"
import { convertToModelMessages, streamText, UIMessage } from 'ai';
import { saveChat } from '@util/chat-store';

export async function POST(req: Request) {
  const { messages, chatId }: { messages: UIMessage[]; chatId: string } =
    await req.json();

  const result = streamText({
    model,
    messages: await convertToModelMessages(messages),
  });

  // consume the stream to ensure it runs to completion & triggers onFinish
  // even when the client response is aborted:
  result.consumeStream(); // no await

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    onFinish: ({ messages }) => {
      saveChat({ chatId, messages });
    },
  });
}
```

> When the client reloads the page after a disconnect, the chat will be restored from the storage solution.
>
> In production applications, you would also track the state of the request (in progress, complete) in your stored messages and use it on the client to cover the case where the client reloads the page after a disconnection, but the streaming is not yet complete.
>
> For more robust handling of disconnects, you may want to add resumability on disconnects. Check out the [Chatbot Resume Streams](/docs/ai-sdk-ui/chatbot-resume-streams) documentation to learn more.

### 5.5 心跳 / keep-alive

**官方 docs 未提供专门的心跳 / keep-alive 配置章节。** 可确证的原文只有一条（`50-stream-protocol.mdx:107-109`）：

> The data stream protocol uses Server-Sent Events (SSE) format for improved standardization, keep-alive through ping, reconnect capabilities, and better cache handling.

即协议层面声称支持 "keep-alive through ping"，但**未查到**心跳间隔配置项、`:` 注释心跳行格式、或 `ping` part 的具体说明。

---

## 6. `writer.write({ type: 'data-xxx' })` 与 `onData` 示例原文

**来源**：`docs/04-ai-sdk-ui/20-streaming-data.mdx` ↔ <https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data>

### 6.1 服务端完整示例（`:49-128`，节选关键段）

```tsx filename="route.ts"
import { openai } from '@ai-sdk/openai';
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  convertToModelMessages,
} from 'ai';
__PROVIDER_IMPORT__;
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

      // 2. Send sources (useful for RAG use cases)
      writer.write({
        type: 'source',
        value: {
          type: 'source',
          sourceType: 'url',
          id: 'source-1',
          url: 'https://weather.com',
          title: 'Weather Data Source',
        },
      });

      // 3. Send data parts with loading state
      writer.write({
        type: 'data-weather',
        id: 'weather-1',
        data: { city: 'San Francisco', status: 'loading' },
      });

      const result = streamText({
        model: __MODEL__,
        messages: await convertToModelMessages(messages),
        onFinish() {
          // 4. Update the same data part (reconciliation)
          writer.write({
            type: 'data-weather',
            id: 'weather-1', // Same ID = update existing part
            data: {
              city: 'San Francisco',
              ...
```

### 6.2 持久 data part（`:131-141`）

```tsx
writer.write({
  type: 'data-weather',
  id: 'weather-1', // Optional: enables reconciliation
  data: { city: 'San Francisco', status: 'loading' },
});
```

原文（`:133`）：

> Regular data parts are added to the message history and appear in `message.parts`:

### 6.3 transient data part + `onData`（`:160-182`）

原文（`:162`）：

> Transient parts are sent to the client but not added to the message history. They are only accessible via the `onData` useChat handler:

```tsx
// server
writer.write({
  type: 'data-notification',
  data: { message: 'Processing...', level: 'info' },
  transient: true, // Won't be added to message history
});

// client
const [notification, setNotification] = useState();

const { messages } = useChat({
  onData: ({ data, type }) => {
    if (type === 'data-notification') {
      setNotification({ message: data.message, level: data.level });
    }
  },
});
```

> ⚠️ 注意形态差异：本文档 `:176` 写成 `onData: ({ data, type }) => {}`（解构），而 `01-use-chat.mdx:330-335` 的签名是 `(dataPart: DataUIPart) => void`，`02-chatbot.mdx:352` 与 `20-streaming-data.mdx:207` 都写成单参数 `data => {}` / `dataPart => {}`。**单参数是参考页签名，解构写法属于文档内不一致**，实现时以 `dataPart.type` / `dataPart.data` 为准。

### 6.4 `onData` 处理所有 data part（`:199-224`）

```tsx filename="page.tsx"
import { useChat } from '@ai-sdk/react';
import type { MyUIMessage } from '@/ai/types';

const { messages } = useChat<MyUIMessage>({
  api: '/api/chat',
  onData: dataPart => {
    // Handle all data parts as they arrive (including transient parts)
    console.log('Received data part:', dataPart);

    // Handle different data part types
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

> **Important:** Transient data parts are **only** available through the `onData` callback. They will not appear in the `message.parts` array since they're not added to message history.

### 6.5 Data Part Reconciliation（`:184-193`）

> When you write to a data part with the same ID, the client automatically reconciles and updates that part. This enables powerful dynamic experiences like:
>
> - **Collaborative artifacts** - Update code, documents, or designs in real-time
> - **Progressive data loading** - Show loading states that transform into final results
> - **Live status updates** - Update progress bars, counters, or status indicators
> - **Interactive components** - Build UI elements that evolve based on user interaction
>
> The reconciliation happens automatically - simply use the same `id` when writing to the stream.

---

## 7. v5 → v6 breaking change 清单

**来源**：`docs/08-migration-guides/24-migration-guide-6-0.mdx` ↔ <https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0>

### 7.1 包版本要求（原文 `:16-23`）

> You need to update the following packages to the latest versions in your `package.json` file(s):
>
> - `ai` package: `^6.0.0`
> - `@ai-sdk/provider` package: `^3.0.0`
> - `@ai-sdk/provider-utils` package: `^4.0.0`
> - `@ai-sdk/*` packages: `^3.0.0`

### 7.2 Codemod（原文 `:31-81`）

运行 `npx @ai-sdk/codemod v6`。Codemod 表原文：

| Codemod Name | Description |
| --- | --- |
| `rename-text-embedding-to-embedding` | Renames `textEmbeddingModel` to `embeddingModel` and `textEmbedding` to `embedding` on providers |
| `rename-mock-v2-to-v3` | Renames V2 mock classes from `ai/test` to V3 (e.g., `MockLanguageModelV2` → `MockLanguageModelV3`) |
| `rename-tool-call-options-to-tool-execution-options` | Renames the `ToolCallOptions` type to `ToolExecutionOptions` |
| `rename-core-message-to-model-message` | Renames the `CoreMessage` type to `ModelMessage` |
| `rename-converttocoremessages-to-converttomodelmessages` | Renames `convertToCoreMessages` function to `convertToModelMessages` |
| `rename-vertex-provider-metadata-key` | Renames `google` to `vertex` in `providerMetadata` and `providerOptions` for Google Vertex files |
| `wrap-tomodeloutput-parameter` | Wraps `toModelOutput` parameter in object destructuring (`output` → `{ output }`) |
| `add-await-converttomodelmessages` | Adds `await` to `convertToModelMessages` calls (now async in AI SDK 6) |

### 7.3 AI SDK Core 变更（标题原文，`:83-525`）

> - `Experimental_Agent` to `ToolLoopAgent` Class
> - `CoreMessage` Removal
> - `generateObject` and `streamObject` Deprecation
> - async `convertToModelMessages`
> - `Tool.toModelOutput` changes
> - Remove `name` from Function Tool Definitions
> - `cachedInputTokens` and `reasoningTokens` in `LanguageModelUsage` Deprecation
> - `ToolCallOptions` to `ToolExecutionOptions` Rename
> - Per-Tool Strict Mode
> - Flexible Tool Content
> - `ToolCallRepairFunction` Signature
> - Embedding Model Method Rename
> - Warning Logger
> - Warning Type Unification
> - Finish reason "unknown" merged into "other"

### 7.4 AI SDK UI 变更（`## AI SDK UI` 章节原文 `:526-638`）

**(a) Tool UI Part Approval States**（`:528-551`）：

> AI SDK 6 adds `approval-requested`, `approval-responded`, and `output-denied` to the tool UI part `state` union. Update exhaustive `switch` statements and other state handling to cover the three approval states.

```tsx filename="AI SDK 6"
switch (part.state) {
  case 'input-streaming':
    return 'Loading input';
  case 'input-available':
    return 'Input ready';
  case 'approval-requested':
    return 'Approval requested';
  case 'approval-responded':
    return 'Approval response received';
  case 'output-available':
    return 'Output ready';
  case 'output-error':
    return part.errorText;
  case 'output-denied':
    return 'Tool call denied';
}
```

**(b) Tool UI Part Helper Functions Rename**（`:556-638`）：

> The tool UI part helper functions have been renamed to better reflect their purpose and to accommodate both static and dynamic tool parts.
>
> - `isToolUIPart` → `isStaticToolUIPart`
> - `isToolOrDynamicToolUIPart` → `isToolUIPart`（旧名 deprecated 但可用）
> - `getToolName` → `getStaticToolName`
> - `getToolOrDynamicToolName` → `getToolName`（旧名 deprecated 但可用）

### 7.5 与「续传 / 恢复」直接相关的 v6 变化

**未查到** v6 migration guide 中有针对 `resumeStream` / `reconnectToStream` / `resume` / `consumeSseStream` 的 breaking change 条目。v6 UI 章节的破坏性变更只有上面 (a)(b) 两条，均在 tool UI part 上。续传相关 API 的最近一次更名记录在 **v5**（`26-migration-guide-5-0.mdx:1708-1720`，见 1.5(d)）。

---

## 8. 非 Next.js 自建 HTTP 服务

**来源**：`docs/07-reference/02-ai-sdk-ui/42-pipe-ui-message-stream-to-response.mdx` ↔ <https://ai-sdk.dev/docs/reference/ai-sdk-ui/pipe-ui-message-stream-to-response>

原文定义：

> The `pipeUIMessageStreamToResponse` function pipes streaming data to a Node.js ServerResponse object (see [Streaming Data](/docs/ai-sdk-ui/streaming-data)).

官方示例原文：

```tsx
await pipeUIMessageStreamToResponse({
  response: serverResponse,
  status: 200,
  statusText: 'OK',
  headers: {
    'Custom-Header': 'value',
  },
  stream: myUIMessageStream,
  consumeSseStream: ({ stream }) => {
    // Optional: consume the SSE stream independently
    console.log('Consuming SSE stream:', stream);
  },
});
```

参数原文：

> - `response`：`ServerResponse` —— The Node.js ServerResponse object to pipe the data to.
> - `stream`：`ReadableStream<UIMessageChunk>` —— The UI message stream to pipe to the response.
> - `status`：`number`，optional —— The status code for the response.
> - `statusText`：`string`，optional —— The status text for the response.
> - `headers`：`Headers | Record<string, string>`，optional —— Additional headers for the response.
> - `consumeSseStream`：`({ stream }: { stream: ReadableStream<string> }) => PromiseLike<void> | void`，optional —— Optional function to consume the SSE stream independently. **The stream is teed and this function receives a copy.**

Returns 原文：

> A `Promise<void>` that resolves when the stream has been written to the response and rejects when reading or writing the stream fails.

`streamText` 结果对象上也有同名方法（`02-stream-text.mdx:3576-3579`）：

> `pipeUIMessageStreamToResponse`：`(response: ServerResponse, options?: ResponseInit & UIMessageStreamOptions) => Promise<void>`
> Writes UI message stream output to a Node.js response-like object.

### 差异总结（基于上述原文）

- `createUIMessageStreamResponse` 返回标准 Web `Response`（默认 200），适合 Next.js Route Handler / Edge / 任何 Web 标准运行时。
- `pipeUIMessageStreamToResponse` 直接写入 Node `ServerResponse`，适合 Express/Fastify/原生 `http` 等自建服务；**官方文档只说明它是 Node.js ServerResponse 场景，未提供 Express/Fastify 的完整续传示例**。
- 关键点：`pipeUIMessageStreamToResponse` 的 `consumeSseStream` 会 **tee** 一份副本给回调（原文 "The stream is teed and this function receives a copy"），因此理论上同样可以接 `resumable-stream`；但**官方未给出非 Next.js 的续传完整实现**，且续传示例中的 `after`（`next/server`）是 Next.js 特有 API → Node 自建服务需自行提供等价的 "响应后继续执行" 机制（官方文档未说明替代方案）。

---

## 9. 明确「未查到」清单（不编造）

以下项目在 `ai@6.0.289` 官方文档与源码中**未查到**：

1. **`resumable-stream` 包自身的官方文档页**。官方仅在续传指南中以 npm 链接引用（`03-chatbot-resume-streams.mdx:36,42`），未提供其 API 详细文档；`createResumableStreamContext` / `createNewResumableStream` / `resumeExistingStream` 的完整参数签名在 AI SDK 文档中没有列出。npm 侧可查：`resumable-stream@2.2.13`，仓库 <https://github.com/vercel/resumable-stream>。
2. **心跳 / keep-alive 的具体配置**（间隔、`:` 注释行、ping part 格式）。只有一句 "keep-alive through ping"（`50-stream-protocol.mdx:109`）。
3. **`UI_MESSAGE_STREAM_HEADERS` 5 个响应头在 docs 里的逐条列表**。docs 侧只有 `x-vercel-ai-ui-message-stream: v1`（`50-stream-protocol.mdx:111-114`）；完整值取自源码 `src/ui-message-stream/ui-message-stream-headers.ts`。用户原文里提到的 `x-accel-buffering` / `cache-control` / `connection` 未在 docs 正文出现，仅在源码常量中。
4. **`resumeStream()` 的准确返回类型**。参考页写作 `() => void`（`01-use-chat.mdx:458-459`），源码为 `async ... : Promise<void>`（`src/ui/chat.ts:470`），两者不一致。
5. **非 Next.js 自建服务的续传完整示例**（含 `after` 的替代机制）。
6. **v6 migration guide 中与续传 API 相关的 breaking change**（该 guide 的 UI 变更仅涉及 tool UI part）。
7. **「不重跑已产出部分」的显式官方承诺**。官方只承诺 "reconnect to an active stream"，未承诺不重新调用模型。

---

## 10. 参考链接汇总

| 主题 | 官方 URL | 本地 v6 文件 |
| --- | --- | --- |
| Chatbot（status/error/callbacks/throttle） | <https://ai-sdk.dev/docs/ai-sdk-ui/chatbot> | `docs/04-ai-sdk-ui/02-chatbot.mdx` |
| Chatbot Resume Streams（续传） | <https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams> | `docs/04-ai-sdk-ui/03-chatbot-resume-streams.mdx` |
| Chatbot Message Persistence（messageId/onFinish/consumeStream） | <https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence> | `docs/04-ai-sdk-ui/03-chatbot-message-persistence.mdx` |
| Stream Protocols（chunk/响应头/`[DONE]`） | <https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol> | `docs/04-ai-sdk-ui/50-stream-protocol.mdx` |
| Streaming Custom Data（writer.write/onData） | <https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data> | `docs/04-ai-sdk-ui/20-streaming-data.mdx` |
| Transport（reconnectToStream/自定义 transport） | <https://ai-sdk.dev/docs/ai-sdk-ui/transport> | `docs/04-ai-sdk-ui/21-transport.mdx` |
| Reading UI Message Streams | <https://ai-sdk.dev/docs/ai-sdk-ui/reading-ui-message-streams> | `docs/04-ai-sdk-ui/24-reading-ui-message-streams.mdx` |
| useChat 参考 | <https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat> | `docs/07-reference/02-ai-sdk-ui/01-use-chat.mdx` |
| createUIMessageStreamResponse | <https://ai-sdk.dev/docs/reference/ai-sdk-ui/create-ui-message-stream-response> | `docs/07-reference/02-ai-sdk-ui/41-create-ui-message-stream-response.mdx` |
| pipeUIMessageStreamToResponse | <https://ai-sdk.dev/docs/reference/ai-sdk-ui/pipe-ui-message-stream-to-response> | `docs/07-reference/02-ai-sdk-ui/42-pipe-ui-message-stream-to-response.mdx` |
| streamText 参考（toUIMessageStreamResponse/consumeSseStream） | <https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text> | `docs/07-reference/01-ai-sdk-core/02-stream-text.mdx` |
| v5→v6 迁移 | <https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0> | `docs/08-migration-guides/24-migration-guide-6-0.mdx` |
| v4→v5 迁移（resumeStream 更名） | <https://ai-sdk.dev/docs/migration-guides/migration-guide-5-0> | `docs/08-migration-guides/26-migration-guide-5-0.mdx` |
| Abort and resumable streams（坑） | <https://ai-sdk.dev/docs/troubleshooting/abort-breaks-resumable-streams> | `docs/09-troubleshooting/15-abort-breaks-resumable-streams.mdx` |
| `resumable-stream` npm 包 | <https://www.npmjs.com/package/resumable-stream> | ——（无官方文档页） |
