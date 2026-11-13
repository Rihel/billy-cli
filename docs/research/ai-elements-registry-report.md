# AI Elements Registry 源码级技术报告（conversation / message / reasoning / tool / task / sources / confirmation / context）

> **状态：调研快照（写作时点）。** 外部库版本与线上文档会继续演进，本文结论不随本仓库代码更新；
> 当前实现见 [`docs/guide/`](../guide/) 与 [`docs/design/`](../design/)。

> 调研对象：`https://elements.ai-sdk.dev/api/registry/<name>.json` 的本地原文副本（`/tmp/aiv6/reg-*.json`）。
> 调研方式：JSON 为 shadcn registry 格式，组件源码内嵌在 `files[0].content`。为便于给出**稳定行号**，已用 Python 将 `files[0].content` 原样落盘为独立 `.tsx`（与 `content` 逐字节一致，行数已校验一致），下文所有「Lxx」均指该文件行号。
>
> | registry | JSON 文件 | `files[0].path`（源路径，行号基准） | 临时副本 | 行数 |
> | --- | --- | --- | --- | --- |
> | conversation | `/tmp/aiv6/reg-conversation.json` | `registry/default/ai-elements/conversation.tsx` | `/tmp/aiv6/ts/conversation.tsx` | 168 |
> | message | `/tmp/aiv6/reg-message.json` | `registry/default/ai-elements/message.tsx` | `/tmp/aiv6/ts/message.tsx` | 360 |
> | reasoning | `/tmp/aiv6/reg-reasoning.json` | `registry/default/ai-elements/reasoning.tsx` | `/tmp/aiv6/ts/reasoning.tsx` | 226 |
> | tool | `/tmp/aiv6/reg-tool.json` | `registry/default/ai-elements/tool.tsx` | `/tmp/aiv6/ts/tool.tsx` | 173 |
> | task | `/tmp/aiv6/reg-task.json` | `registry/default/ai-elements/task.tsx` | `/tmp/aiv6/ts/task.tsx` | 87 |
> | sources | `/tmp/aiv6/reg-sources.json` | `registry/default/ai-elements/sources.tsx` | `/tmp/aiv6/ts/sources.tsx` | 77 |
> | confirmation | `/tmp/aiv6/reg-confirmation.json` | `registry/default/ai-elements/confirmation.tsx` | `/tmp/aiv6/ts/confirmation.tsx` | 174 |
> | context | `/tmp/aiv6/reg-context.json` | `registry/default/ai-elements/context.tsx` | `/tmp/aiv6/ts/context.tsx` | 409 |

## 0. 总体结论（先看这一段）

**架构判断：这 8 个组件没有一个 `import { useChat } from "@ai-sdk/react"`。** 它们只从 `ai` 包引入**类型**，渲染所需的状态（流式中 / 已结束、工具调用状态、审批状态）全部由**调用方从 `message.parts` 里取出来当 props 传进来**。

- 唯一从 `ai` 引入的运行时值：无。全部为 `import type { ... } from "ai"`（conversation L5/L103-116、message L19/L33-34、reasoning 无 ai 导入、tool L10、confirmation L6、context L11）。
- 唯一对 `parts` 做**实际数据访问**的是 conversation 的导出函数 `messagesToMarkdown`（L103-107、L124-130），它按 `part.type === "text"` 过滤。
- 因此「运行时用 vs 结果展示用」不是由组件内部开关决定的，而是**由调用方传入的 part 状态决定的**。组件内部真正做条件渲染的只有 5 处：`ConversationScrollButton` 的 `isAtBottom`、`Reasoning` 的 `isStreaming`（自动展开/自动收起）、`ToolHeader` 的 `state`（徽标文案/图标）、`ToolOutput` 的 `output || errorText`、`Confirmation` 系列的 `state`。

**依赖（各 JSON 顶层 `dependencies` / `registryDependencies` 原文）：**

| 组件 | `dependencies` | `registryDependencies` |
| --- | --- | --- |
| conversation | `ai`, `lucide-react`, `use-stick-to-bottom` | `button` |
| message | `@streamdown/cjk`, `@streamdown/code`, `@streamdown/math`, `@streamdown/mermaid`, `ai`, `lucide-react`, `streamdown` | `button`, `button-group`, `tooltip` |
| reasoning | `@radix-ui/react-use-controllable-state`, `@streamdown/cjk`, `@streamdown/code`, `@streamdown/math`, `@streamdown/mermaid`, `lucide-react`, `streamdown` | `collapsible`, `https://elements.ai-sdk.dev/api/registry/shimmer.json` |
| tool | `ai`, `lucide-react` | `badge`, `collapsible`, `https://elements.ai-sdk.dev/api/registry/code-block.json` |
| task | `lucide-react` | `collapsible` |
| sources | `lucide-react` | `collapsible` |
| confirmation | `ai` | `alert`, `button` |
| context | `ai`, `tokenlens` | `button`, `hover-card`, `progress` |

所有 8 个 registry 条目的 `type` 均为 `registry:component`，`files[0].target` 均为 `components/ai-elements/<name>.tsx`。

**关于「最小用法示例」：8 个 registry JSON 均未查到。** 逐文件 `grep` 结果：`content` 中不含 `@example`、不含 `Usage` 段落（`context.tsx` 命中一次 `Usage` 也只是组件名 `ContextInputUsage` 等），JSON 顶层除 `$schema/dependencies/description/devDependencies/files/name/registryDependencies/title/type` 外**没有 docs/examples/meta 字段**。故本文档第 5 项要求统一记为「未查到（registry 内无示例代码）」，改以「从源码可确认的调用方式」替代（见各节「用法推断」）。

**引用的 AI SDK 类型**来自本地已解包的 `ai@6.0.289`（`/tmp/aiv6/ai/package/dist/index.d.ts`，与 AI Elements 同批下载），用于解释组件 props 里引用的外部类型（`ToolUIPart["state"]`、`UIMessage["role"]`、`LanguageModelUsage`）。

---

## 1. conversation

出处：`reg-conversation.json` → `files[0].path = registry/default/ai-elements/conversation.tsx`。

### 1.1 导出清单（源码 `export const` / `export type`）

| 导出 | 行号 | 种类 |
| --- | --- | --- |
| `ConversationProps` | L11 | type |
| `Conversation` | L13 | const（箭头函数） |
| `ConversationContentProps` | L23 | type |
| `ConversationContent` | L27 | const |
| `ConversationEmptyStateProps` | L37 | type |
| `ConversationEmptyState` | L43 | const |
| `ConversationScrollButtonProps` | L72 | type |
| `ConversationScrollButton` | L74 | const |
| `ConversationDownloadProps` | L109 | type |
| `messagesToMarkdown` | L124 | const（工具函数，非组件） |
| `ConversationDownload` | L132 | const |

无 `export { ... }` 语句；`getMessageText`（L103）、`defaultFormatMessage`（L118）为**未导出**的内部函数。

### 1.2 精确 props 类型（原文抄录）

```tsx
// L11
export type ConversationProps = ComponentProps<typeof StickToBottom>;

// L23-25
export type ConversationContentProps = ComponentProps<
  typeof StickToBottom.Content
>;

// L37-41
export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

// L72
export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

// L109-116
export type ConversationDownloadProps = Omit<
  ComponentProps<typeof Button>,
  "onClick"
> & {
  messages: UIMessage[];
  filename?: string;
  formatMessage?: (message: UIMessage, index: number) => string;
};

// L124-130
export const messagesToMarkdown = (
  messages: UIMessage[],
  formatMessage: (
    message: UIMessage,
    index: number
  ) => string = defaultFormatMessage
): string => messages.map((msg, i) => formatMessage(msg, i)).join("\n\n");
```

要点：

- `Conversation` 的 props **完全等于 `StickToBottom`（第三方库 `use-stick-to-bottom`）的 props**，组件自身不再新增任何 prop（L14-20 只固定了 `initial="smooth"`、`resize="smooth"`、`role="log"`、`className`，其余 `{...props}` 透传）。
- `ConversationEmptyState` 的三个自有 prop 都有默认值：`title = "No messages yet"`、`description = "Start a conversation to see messages here"`、`icon` 无默认（L45-47）。
- `ConversationDownload` 显式 `Omit<..., "onClick">`，即**禁止**外部覆盖点击行为；默认 `filename = "conversation.md"`（L134）。

### 1.3 运行中 / 完成态的条件渲染（关键判断原文）

**唯一的运行时判断在 `ConversationScrollButton`：**

```tsx
// L78
const { isAtBottom, scrollToBottom } = useStickToBottomContext();
// L84-101
return (
    !isAtBottom && (
      <Button
        ...
        onClick={handleScrollToBottom}
```

即：**不在底部时才渲染**该滚动到底部按钮；`isAtBottom` 来自 `use-stick-to-bottom` 的上下文（随滚动/流式增长实时变化）。这是本文件中唯一「随运行态变化」的渲染分支。

`Conversation` 本身没有任何 `isStreaming`/`status` 判断；自动吸底行为由 `<StickToBottom initial="smooth" resize="smooth">`（L16-17）配置，属于「运行中消息不断追加时自动贴底」。

`ConversationDownload`（L132-168）是**结果展示/导出**用途：把 `messages` 转 markdown 后用 `Blob` + 临时 `<a download>` 触发下载（L140-151）。

### 1.4 消费的 UIMessage part 类型 / 对 `useChat` 字段的要求

- 运行时值消费：`messagesToMarkdown` 与 `getMessageText` 读取 `part.type === "text"` 后取 `part.text`：

```tsx
// L103-107
const getMessageText = (message: UIMessage): string =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
```

- 默认格式化含 `message.role`（L118-122，`roleLabel = role.charAt(0).toUpperCase() + role.slice(1)`）。
- **不要求 `useChat` 的任何字段**：本文件不导入 `useChat`。调用方只需提供 `UIMessage[]`（`{ id, role, parts }`，见 `ai@6.0.289` `dist/index.d.ts` L1585-1601：`role: 'system' | 'user' | 'assistant'`，L1615 `parts: Array<UIMessagePart<...>>`）。

### 1.5 最小用法

registry 内**未查到**示例代码。从源码可确认的最小调用方式：

```tsx
<Conversation>
  <ConversationContent>
    {messages.map(m => /* 渲染 Message */ null)}
  </ConversationContent>
  <ConversationScrollButton />
  <ConversationDownload messages={messages} />
</Conversation>
```

（`ConversationEmptyState` 可放在 `ConversationContent` 内做空态；`ConversationDownload` 需要 `messages: UIMessage[]`。）

---

## 2. message

出处：`files[0].path = registry/default/ai-elements/message.tsx`。本组件是 8 个里子组件最多的（24 个导出）。

### 2.1 导出清单

`Message`（L37）、`MessageContent`（L50）、`MessageActions`（L70）、`MessageAction`（L85）、`MessageBranch`（L146）、`MessageBranchContent`（L199）、`MessageBranchSelector`（L232）、`MessageBranchPrevious`（L257）、`MessageBranchNext`（L280）、`MessageBranchPage`（L303）、`MessageResponse`（L326）、`MessageToolbar`（L346）；
配套 types：`MessageProps`（L33）、`MessageContentProps`（L48）、`MessageActionsProps`（L68）、`MessageActionProps`（L80）、`MessageBranchProps`（L141）、`MessageBranchContentProps`（L197）、`MessageBranchSelectorProps`（L230）、`MessageBranchPreviousProps`（L255）、`MessageBranchNextProps`（L278）、`MessageBranchPageProps`（L301）、`MessageResponseProps`（L322）、`MessageToolbarProps`（L344）。

未导出（文件内部）：`MessageBranchContextType`（L116）、`MessageBranchContext`（L125）、`useMessageBranch`（L129）、`streamdownPlugins`（L324）。

### 2.2 精确 props 类型（原文抄录）

```tsx
// L33-35  —— from 的取值来源
export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

// L48
export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

// L68
export type MessageActionsProps = ComponentProps<"div">;

// L80-83
export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

// L141-144
export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

// L197
export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

// L230
export type MessageBranchSelectorProps = ComponentProps<typeof ButtonGroup>;

// L255
export type MessageBranchPreviousProps = ComponentProps<typeof Button>;

// L278
export type MessageBranchNextProps = ComponentProps<typeof Button>;

// L301
export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

// L322
export type MessageResponseProps = ComponentProps<typeof Streamdown>;

// L344
export type MessageToolbarProps = ComponentProps<"div">;
```

内部上下文类型（L116-123）：

```tsx
interface MessageBranchContextType {
  currentBranch: number;
  totalBranches: number;
  goToPrevious: () => void;
  goToNext: () => void;
  branches: ReactElement[];
  setBranches: (branches: ReactElement[]) => void;
}
```

**`from` 的确切取值**：`MessageProps["from"]` 的类型是 `UIMessage["role"]`，即 `'system' | 'user' | 'assistant'`（依据 `ai@6.0.289` `dist/index.d.ts` L1589 `role: 'system' | 'user' | 'assistant';`）。源码里比较的只有 `"user"`：

```tsx
// L41
from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
```

即 `system` 与 `assistant` 走同一分支（`is-assistant`）。

**`MessageResponseProps` 的实际字段**：本组件未自定义任何 prop，等于 `Streamdown` 组件的 props。本地未下载 `streamdown` 包（`find` 无结果），故 `Streamdown` 具体 props 列表**未查到**；但从 L337-339 的 memo 比较器可确认 `streamdown` 至少接受 `children` 与 `isAnimating`：

```tsx
// L326-342
export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className
      )}
      plugins={streamdownPlugins}
      {...props}
    />
  ),
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    nextProps.isAnimating === prevProps.isAnimating
);
```

### 2.3 运行中 / 完成态的条件渲染（关键判断原文）

message.tsx **没有显式的 `isStreaming` / `state === ...` 分支**（`grep` 无命中）。它把「运行中」的表达交给下游：

- `MessageResponse` 把 `isAnimating` 透传给 `Streamdown`（L339），由 Streamdown 决定逐字/动画效果 —— 这是本组件与「流式中」关联最直接的机制。
- 唯一的分支判断是分支选择器的数量判断与分支可见性：

```tsx
// L238-241  MessageBranchSelector
  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null;
  }
```

```tsx
// L216-227  MessageBranchContent：非当前分支用 hidden 隐藏
  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        "grid gap-2 overflow-hidden [&>div]:pb-0",
        index === currentBranch ? "block" : "hidden"
      )}
```

```tsx
// L211-214  子元素数量变化时同步分支列表
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray);
    }
```

`MessageAction` 的分支是 tooltip 有无（L100-113）：传了 `tooltip` 才包 `TooltipProvider/Tooltip/TooltipTrigger/TooltipContent`；无障碍文本取 `label || tooltip`（L96）。

### 2.4 消费的 UIMessage part 类型 / 对 `useChat` 字段的要求

- **本文件对 part 不做任何运行时读取**（无 `.parts` 访问）；`UIMessage` 仅以 `import type` 出现于 L19，仅用于 L34 的 `from: UIMessage["role"]`。注释里出现的 "branch / role" 语义由调用方映射。
- **不要求 `useChat` 的任何字段**；调用方把 `message.role` 作为 `from` 传入即可。
- 结论：`Message`/`MessageContent`/`MessageActions`/`MessageToolbar` 是**纯展示骨架**；`MessageBranch*` 是**多候选回答切换器**（本地状态，不发请求）；`MessageResponse` 是 Markdown 渲染出口（结果展示，带 `isAnimating` 运行态钩子）。

### 2.5 最小用法

registry 内**未查到**示例。从源码可确认的最小调用方式：

```tsx
<Message from={message.role}>
  <MessageContent>
    <MessageResponse isAnimating={status === "streaming"}>{text}</MessageResponse>
  </MessageContent>
  <MessageActions>
    <MessageAction tooltip="Copy" onClick={...} />
  </MessageActions>
</Message>
```

（`MessageAction` 的 `Button` 默认 `variant = "ghost"`、`size = "icon-sm"`，L89-90；`MessageBranch` 默认 `defaultBranch = 0`，L147。）

---

## 3. reasoning

出处：`files[0].path = registry/default/ai-elements/reasoning.tsx`。**本组件是 8 个里显式建模「流式中」最完整的一个。**

### 3.1 导出清单

`useReasoning`（L39，自定义 hook）、`Reasoning`（L58）、`ReasoningTrigger`（L167）、`ReasoningContent`（L209）；
types：`ReasoningProps`（L47）、`ReasoningTriggerProps`（L151）、`ReasoningContentProps`（L201）。
文件内部：`ReasoningContextValue`（L30，未导出）、`ReasoningContext`（L37）、`AUTO_CLOSE_DELAY = 1000`（L55）、`MS_IN_S = 1000`（L56）、`defaultGetThinkingMessage`（L157）。

`Reasoning.displayName = "Reasoning"`、`ReasoningTrigger.displayName`、`ReasoningContent.displayName`（L224-226）。

### 3.2 精确 props 类型（原文抄录）

```tsx
// L30-35
interface ReasoningContextValue {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
}

// L47-53  —— isStreaming 明确存在
export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
};

// L151-155
export type ReasoningTriggerProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
};

// L201-205  —— children 被强制为 string
export type ReasoningContentProps = ComponentProps<
  typeof CollapsibleContent
> & {
  children: string;
};
```

默认值：`isStreaming = false`（L61）、`defaultOpen ?? isStreaming`（L69）、`duration` 默认 `undefined`（L79-81）。

### 3.3 运行中 / 完成态的条件渲染（关键判断原文，本组件核心）

```tsx
// L55-56
const AUTO_CLOSE_DELAY = 1000;
const MS_IN_S = 1000;
```

```tsx
// L69-71
    const resolvedDefaultOpen = defaultOpen ?? isStreaming;
    // Track if defaultOpen was explicitly set to false (to prevent auto-open)
    const isExplicitlyClosed = defaultOpen === false;
```

```tsx
// L88-98  用 isStreaming 起止计算耗时（秒）
    useEffect(() => {
      if (isStreaming) {
        hasEverStreamedRef.current = true;
        if (startTimeRef.current === null) {
          startTimeRef.current = Date.now();
        }
      } else if (startTimeRef.current !== null) {
        setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S));
        startTimeRef.current = null;
      }
    }, [isStreaming, setDuration]);
```

```tsx
// L100-105  开始流式 => 自动展开（除非显式 defaultOpen={false}）
    useEffect(() => {
      if (isStreaming && !isOpen && !isExplicitlyClosed) {
        setIsOpen(true);
      }
    }, [isStreaming, isOpen, setIsOpen, isExplicitlyClosed]);
```

```tsx
// L107-122  流式结束 => 1000ms 后自动收起，且仅自动收起一次
    useEffect(() => {
      if (
        hasEverStreamedRef.current &&
        !isStreaming &&
        isOpen &&
        !hasAutoClosed
      ) {
        const timer = setTimeout(() => {
          setIsOpen(false);
          setHasAutoClosed(true);
        }, AUTO_CLOSE_DELAY);

        return () => clearTimeout(timer);
      }
    }, [isStreaming, isOpen, setIsOpen, hasAutoClosed]);
```

触发器的「运行中 vs 完成态」文案判定：

```tsx
// L157-165
const defaultGetThinkingMessage = (isStreaming: boolean, duration?: number) => {
  if (isStreaming || duration === 0) {
    return <Shimmer duration={1}>Thinking...</Shimmer>;
  }
  if (duration === undefined) {
    return <p>Thought for a few seconds</p>;
  }
  return <p>Thought for {duration} seconds</p>;
};
```

展开图标的旋转：

```tsx
// L188-192
            <ChevronDownIcon
              className={cn(
                "size-4 transition-transform",
                isOpen ? "rotate-180" : "rotate-0"
              )}
            />
```

**结论：`reasoning` 是典型的「运行时组件」**——`isStreaming` 同时驱动初始展开态、自动展开、自动收起、文案（`Thinking...` / `Thought for N seconds`）与耗时统计。`ReasoningContent` 用 `Streamdown` 渲染（L219），children 必须是字符串。

### 3.4 消费的 UIMessage part 类型 / 对 `useChat` 字段的要求

- 本文件**不导入 `ai`**，不访问 `message.parts`，无 `useChat` 依赖。
- 它消费的是 `ReasoningUIPart` 的**语义**：调用方需要自己判断该 reasoning part 是否仍在流式，并把结果作为 `isStreaming` 传入。可用的判据来自 `ai@6.0.289` 的 `ReasoningUIPart`（`dist/index.d.ts` L1633-1648）：
  `type: 'reasoning'` + `text: string` + `state?: 'streaming' | 'done'`。即最直接的映射是 `isStreaming={part.state === "streaming"}`（该表达式为本报告依据类型定义给出的推断，**组件源码中并未出现**）。
- `duration` 由组件内部用 `Date.now()` 自行测量（L92-96），不需要调用方提供，但可被 `duration` prop 覆盖（L78-81）。

### 3.5 最小用法

registry 内**未查到**示例。源码内**自带的调用方式**（L157-165 的默认文案 + L69 的默认展开）：

```tsx
<Reasoning isStreaming={part.state === "streaming"} duration={partDurationSec}>
  <ReasoningTrigger />
  <ReasoningContent>{part.text}</ReasoningContent>
</Reasoning>
```

依赖 `registryDependencies` 中的 `shimmer.json`（L28 `import { Shimmer } from "./shimmer";`）。

---

## 4. tool

出处：`files[0].path = registry/default/ai-elements/tool.tsx`。**本组件是 8 个里唯一直接消费 `ToolUIPart["state"]` 枚举的组件。**

### 4.1 导出清单

`Tool`（L26）、`getStatusBadge`（L67，工具函数）、`ToolHeader`（L74）、`ToolContent`（L105）、`ToolInput`（L119）、`ToolOutput`（L135）；
types：`ToolProps`（L24）、`ToolPart`（L33）、`ToolHeaderProps`（L35）、`ToolContentProps`（L103）、`ToolInputProps`（L115）、`ToolOutputProps`（L130）。
文件内部：`statusLabels`（L47）、`statusIcons`（L57）。

### 4.2 精确 props 类型（原文抄录）

```tsx
// L24
export type ToolProps = ComponentProps<typeof Collapsible>;

// L33
export type ToolPart = ToolUIPart | DynamicToolUIPart;

// L35-45  —— 判别联合：静态工具用 type，动态工具额外必须给 toolName
export type ToolHeaderProps = {
  title?: string;
  className?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

// L103
export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

// L115-117
export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

// L130-133
export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};
```

**`state` 的确切枚举取值**（源码把 `ToolPart["state"]` 列出为 7 个键，L47-55）：

```tsx
// L47-55
const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};
```

对应图标（L57-65）：

```tsx
const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-4 text-yellow-600" />,
  "approval-responded": <CheckCircleIcon className="size-4 text-blue-600" />,
  "input-available": <ClockIcon className="size-4 animate-pulse" />,
  "input-streaming": <CircleIcon className="size-4" />,
  "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
  "output-denied": <XCircleIcon className="size-4 text-orange-600" />,
  "output-error": <XCircleIcon className="size-4 text-red-600" />,
};
```

**`type` 的确切取值**：`ToolUIPart["type"]` 在 AI SDK 中是模板字面量 `` `tool-${NAME}` ``（`ai@6.0.289` `dist/index.d.ts` L1813-1817），`DynamicToolUIPart["type"]` 是字面量 `'dynamic-tool'`（同文件 L1825-1829）。组件的名字派生逻辑原文（L82-83）：

```tsx
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");
```

即 `type="tool-weather"` 显示名为 `weather`；`type="dynamic-tool"` 时取 `toolName`。

### 4.3 运行中 / 完成态的条件渲染（关键判断原文）

tool.tsx **没有显式 if 判断 state**，运行态/完成态完全通过 `state` 查表得到徽标文案与图标（L67-72）：

```tsx
// L67-72
export const getStatusBadge = (status: ToolPart["state"]) => (
  <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
);
```

调用点（L96）：`{getStatusBadge(state)}`。因此：
- `"input-streaming"` → `Pending` + 空心圆；
- `"input-available"` → `Running` + 脉冲时钟（**这是「正在运行」的语义位**）；
- `"output-available"` → `Completed` + 绿色勾（**完成态**）；
- `"output-error"` → `Error` + 红叉；`"output-denied"` → `Denied`；审批相关两态 → `Awaiting Approval` / `Responded`。

**唯一真正的渲染条件判断在 `ToolOutput`（L141-153）**：

```tsx
  if (!(output || errorText)) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else if (typeof output === "string") {
    Output = <CodeBlock code={output} language="json" />;
  }
```

以及标题按 `errorText` 切换（L158）：`{errorText ? "Error" : "Result"}`，容器配色也由 `errorText` 决定（L163-166）。

`ToolInput` **无条件渲染**（L119-128），标题固定 `Parameters`，把 `input` 一律 `JSON.stringify(input, null, 2)` 后交给 `CodeBlock language="json"`。

### 4.4 消费的 UIMessage part 类型 / 对 `useChat` 字段的要求

- 导入：`import type { DynamicToolUIPart, ToolUIPart } from "ai";`（L10）。**运行时值只用到 `isValidElement`（React）与 `JSON.stringify`**。
- 消费的 part 类型：`tool-<name>`（`ToolUIPart`）与 `dynamic-tool`（`DynamicToolUIPart`）两类。源码取用的字段：`type`（L83）、`state`（L47-65）、`input`（L116/L125）、`output`（L131/L141-153）、`errorText`（L132/L141/L158/L168）、动态工具额外取 `toolName`（L83）。
- 这些字段在 `ai@6.0.289` 中确实存在于这两种 part（`ToolUIPart` = `{ type: \`tool-${NAME}\` } & UIToolInvocation<...>`，`dist/index.d.ts` L1813-1817；`DynamicToolUIPart` L1825-1830 含 `toolName: string` 与 `state` 联合）。
- **不要求 `useChat` 的任何字段**；调用方把某个 tool part 摊开成 props 即可。典型映射（本报告依据类型给出的推断，非组件源码）：`<ToolHeader type={part.type} state={part.state} />`、`<ToolInput input={part.input} />`、`<ToolOutput output={part.output} errorText={part.errorText} />`。

### 4.5 最小用法

registry 内**未查到**示例。由 L35-45 与 L115-133 可确认的调用方式：

```tsx
<Tool>
  <ToolHeader type={part.type} state={part.state} />
  <ToolContent>
    <ToolInput input={part.input} />
    <ToolOutput output={part.output} errorText={part.errorText} />
  </ToolContent>
</Tool>
```

依赖 `registryDependencies` 中的 `code-block.json`（L22 `import { CodeBlock } from "./code-block";`）与 `badge`。

---

## 5. task

出处：`files[0].path = registry/default/ai-elements/task.tsx`。

### 5.1 导出清单

`TaskItemFile`（L14）、`TaskItem`（L32）、`Task`（L40）、`TaskTrigger`（L52）、`TaskContent`（L71）；
types：`TaskItemFileProps`（L12）、`TaskItemProps`（L30）、`TaskProps`（L38）、`TaskTriggerProps`（L48）、`TaskContentProps`（L69）。

### 5.2 精确 props 类型（原文抄录）

```tsx
// L12
export type TaskItemFileProps = ComponentProps<"div">;

// L30
export type TaskItemProps = ComponentProps<"div">;

// L38
export type TaskProps = ComponentProps<typeof Collapsible>;

// L48-50  —— 唯一的必需自有 prop
export type TaskTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  title: string;
};

// L69
export type TaskContentProps = ComponentProps<typeof CollapsibleContent>;
```

默认值：`Task` 的 `defaultOpen = true`（L41）；`TaskTrigger` 的 `title` **必填**，无 children 时渲染 `SearchIcon + title + ChevronDownIcon`（L59-65）。

### 5.3 运行中 / 完成态的条件渲染（关键判断原文）

**没有。** 本文件 `grep` 无 `isStreaming` / `state` / `status` 命中；`TaskProps` 只是 `Collapsible` 的 props。全部展开/收起行为委托给 `Collapsible`（`defaultOpen` 控制初始态，L45）。

```tsx
// L40-46
export const Task = ({
  defaultOpen = true,
  className,
  ...props
}: TaskProps) => (
  <Collapsible className={cn(className)} defaultOpen={defaultOpen} {...props} />
);
```

```tsx
// L76-86  TaskContent 内部结构：左侧竖线的任务项列表
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className
    )}
    {...props}
  >
    <div className="mt-4 space-y-2 border-muted border-l-2 pl-4">
      {children}
    </div>
  </CollapsibleContent>
```

因此「哪些任务完成 / 进行中」**不在组件内表达**，需要调用方在 `TaskItem` 的 children 里自行渲染（`TaskItem`/`TaskItemFile` 都是纯 `div`，无状态 props，L14-36）。

### 5.4 消费的 UIMessage part 类型 / 对 `useChat` 字段的要求

- **不导入 `ai`**，不访问 `message.parts`，无 `useChat` 依赖。
- 从 part 的角度看，它对应的是「任务清单」这类 `data-*` 或工具输出的**结果展示**，但源码中**没有任何 `data-` / `tool-` 字面量**，故这一映射不由组件保证。

### 5.5 最小用法

registry 内**未查到**示例。由源码可确认的调用方式：

```tsx
<Task defaultOpen>
  <TaskTrigger title="Searching the web" />
  <TaskContent>
    <TaskItem>
      正在分析结果 <TaskItemFile>report.md</TaskItemFile>
    </TaskItem>
  </TaskContent>
</Task>
```

---

## 6. sources

出处：`files[0].path = registry/default/ai-elements/sources.tsx`。

### 6.1 导出清单

`Sources`（L14）、`SourcesTrigger`（L25）、`SourcesContent`（L46）、`Source`（L62）；
types：`SourcesProps`（L12）、`SourcesTriggerProps`（L21）、`SourcesContentProps`（L44）、`SourceProps`（L60）。

### 6.2 精确 props 类型（原文抄录）

```tsx
// L12
export type SourcesProps = ComponentProps<"div">;

// L21-23  —— count 必填
export type SourcesTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  count: number;
};

// L44
export type SourcesContentProps = ComponentProps<typeof CollapsibleContent>;

// L60
export type SourceProps = ComponentProps<"a">;
```

注意：`SourcesProps` 是 `ComponentProps<"div">`，但组件实际把它透传给 `Collapsible`（L14-19，`<Collapsible className={...} {...props} />`）——这是源码中的类型与运行时不严格一致之处。

### 6.3 运行中 / 完成态的条件渲染（关键判断原文）

**没有 `isStreaming`/`state`/`status` 判断**；唯一条件渲染是「有没有传 children」：

```tsx
// L35-41  SourcesTrigger 默认文案
    {children ?? (
      <>
        <p className="font-medium">Used {count} sources</p>
        <ChevronDownIcon className="h-4 w-4" />
      </>
    )}
```

```tsx
// L70-75  Source 默认图标+标题，链接固定新窗口打开
    {children ?? (
      <>
        <BookIcon className="h-4 w-4" />
        <span className="block font-medium">{title}</span>
      </>
    )}
```

```tsx
// L62-69
export const Source = ({ href, title, children, ...props }: SourceProps) => (
  <a
    className="flex items-center gap-2"
    href={href}
    rel="noreferrer"
    target="_blank"
    {...props}
  >
```

即 `Sources` 是**纯结果展示**组件：`count` 由调用方数出来，`href`/`title` 由调用方给出。

### 6.4 消费的 UIMessage part 类型 / 对 `useChat` 字段的要求

- **不导入 `ai`**，无 `useChat` 依赖，源码里没有 `source-url` / `source-document` 字面量。
- 语义上对应 AI SDK 的 `SourceUrlUIPart`（`type: 'source-url'`，字段 `sourceId`/`url`/`title?`，见 `ai@6.0.289` `dist/index.d.ts` L1663-1669），但**组件并未引用该类型**；`count` 与 `href`/`title` 需调用方从 parts 中自行汇总（例如过滤 `part.type === "source-url"`）——此映射为本报告推断，组件源码未实现。

### 6.5 最小用法

registry 内**未查到**示例。由源码可确认的调用方式：

```tsx
<Sources>
  <SourcesTrigger count={sourceParts.length} />
  <SourcesContent>
    {sourceParts.map(p => <Source key={p.sourceId} href={p.url} title={p.title} />)}
  </SourcesContent>
</Sources>
```

---

## 7. confirmation

出处：`files[0].path = registry/default/ai-elements/confirmation.tsx`。**这是 8 个里条件渲染分支最密集的组件（request / accepted / rejected 三态流程）。**

### 7.1 导出清单

`Confirmation`（L62）、`ConfirmationTitle`（L83）、`ConfirmationRequest`（L94）、`ConfirmationAccepted`（L109）、`ConfirmationRejected`（L131）、`ConfirmationActions`（L151）、`ConfirmationAction`（L172）；
types：`ConfirmationProps`（L57）、`ConfirmationTitleProps`（L81）、`ConfirmationRequestProps`（L90）、`ConfirmationAcceptedProps`（L105）、`ConfirmationRejectedProps`（L127）、`ConfirmationActionsProps`（L149）、`ConfirmationActionProps`（L170）。
文件内部：`ToolUIPartApproval`（L10，未导出）、`ConfirmationContextValue`（L38，未导出）、`ConfirmationContext`（L43）、`useConfirmation`（L47，未导出）。

### 7.2 精确 props 类型（原文抄录）

审批对象类型（L10-36）——注意源码里 `approved: true` 的成员**重复出现了两次**，属冗余联合分支，原文照录：

```tsx
// L10-36
type ToolUIPartApproval =
  | {
      id: string;
      approved?: never;
      reason?: never;
    }
  | {
      id: string;
      approved: boolean;
      reason?: string;
    }
  | {
      id: string;
      approved: true;
      reason?: string;
    }
  | {
      id: string;
      approved: true;
      reason?: string;
    }
  | {
      id: string;
      approved: false;
      reason?: string;
    }
  | undefined;

// L38-41
interface ConfirmationContextValue {
  approval: ToolUIPartApproval;
  state: ToolUIPart["state"];
}

// L57-60  —— approval 可选，state 必填
export type ConfirmationProps = ComponentProps<typeof Alert> & {
  approval?: ToolUIPartApproval;
  state: ToolUIPart["state"];
};

// L81
export type ConfirmationTitleProps = ComponentProps<typeof AlertDescription>;

// L90-92 / L105-107 / L127-129  —— 只有 children
export interface ConfirmationRequestProps {
  children?: ReactNode;
}
export interface ConfirmationAcceptedProps {
  children?: ReactNode;
}
export interface ConfirmationRejectedProps {
  children?: ReactNode;
}

// L149
export type ConfirmationActionsProps = ComponentProps<"div">;

// L170
export type ConfirmationActionProps = ComponentProps<typeof Button>;
```

`state` 与 `approval` 的取值域与 tool 组件一致（`ToolUIPart["state"]` 七态，见第 4.2 节表格；`approval` 结构对应 `ai@6.0.289` 的 `approval: { id, approved?, descriptor?, reason?, signature? }`，`dist/index.d.ts` L1752-1761 等）。

### 7.3 request / response 流程的条件渲染（关键判断原文）

**第 0 层：根组件整体短路（L70-72）**

```tsx
  if (!approval || state === "input-streaming" || state === "input-available") {
    return null;
  }
```

即：**没有审批对象、或工具仍在流式输入/已可执行（尚未请求审批）时，整个审批 UI 不渲染。**

**第 1 层：请求态只显示 `ConfirmationRequest` 与 `ConfirmationActions`（L94-103、L151-168）**

```tsx
export const ConfirmationRequest = ({ children }: ConfirmationRequestProps) => {
  const { state } = useConfirmation();

  // Only show when approval is requested
  if (state !== "approval-requested") {
    return null;
  }

  return children;
};
```

```tsx
export const ConfirmationActions = ({
  className,
  ...props
}: ConfirmationActionsProps) => {
  const { state } = useConfirmation();

  // Only show when approval is requested
  if (state !== "approval-requested") {
    return null;
  }

  return (
    <div
      className={cn("flex items-center justify-end gap-2 self-end", className)}
      {...props}
    />
  );
};
```

**第 2 层：响应态按 `approval.approved` 分流（L109-125、L131-147）**

```tsx
export const ConfirmationAccepted = ({
  children,
}: ConfirmationAcceptedProps) => {
  const { approval, state } = useConfirmation();

  // Only show when approved and in response states
  if (
    !approval?.approved ||
    (state !== "approval-responded" &&
      state !== "output-denied" &&
      state !== "output-available")
  ) {
    return null;
  }

  return children;
};
```

```tsx
export const ConfirmationRejected = ({
  children,
}: ConfirmationRejectedProps) => {
  const { approval, state } = useConfirmation();

  // Only show when rejected and in response states
  if (
    approval?.approved !== false ||
    (state !== "approval-responded" &&
      state !== "output-denied" &&
      state !== "output-available")
  ) {
    return null;
  }

  return children;
};
```

流程归纳（严格依据以上判断）：

| `state` | 根组件 | `ConfirmationRequest` | `ConfirmationAccepted` | `ConfirmationRejected` | `ConfirmationActions` |
| --- | --- | --- | --- | --- | --- |
| `input-streaming` / `input-available` | 返回 `null` | — | — | — | — |
| `approval-requested` | 渲染 | 渲染 | `approval.approved` 为真才渲染 | `approved === false` 才渲染 | 渲染 |
| `approval-responded` | 渲染 | 不渲染 | `approved` 为真才渲染 | `approved === false` 才渲染 | 不渲染 |
| `output-available` | 渲染 | 不渲染 | 同上 | 同上 | 不渲染 |
| `output-denied` | 渲染 | 不渲染 | 同上 | 同上 | 不渲染 |
| `output-error` | 渲染 | 不渲染 | 不渲染（不在白名单） | 不渲染（不在白名单） | 不渲染 |

注意 `ConfirmationAccepted` / `ConfirmationRejected` 在 `approval-requested` 阶段**并不被 state 白名单挡住**，只被 `approved` 挡：若 `approval-requested` 时 `approval.approved` 已有真/假值，二者会提前渲染。这是源码级的真实行为（L115-122、L137-144）。

### 7.4 消费的 UIMessage part 类型 / 对 `useChat` 字段的要求

- 导入：`import type { ToolUIPart } from "ai";`（L6）。**无 `useChat` 依赖。**
- 消费的是工具 part 的审批子结构：`part.state`（`approval-requested` → `approval-responded` → `output-available` / `output-denied`）与 `part.approval.{id, approved, reason}`（`ToolUIPart` 中这些字段的定义见 `ai@6.0.289` `dist/index.d.ts` L1752-1800）。
- **本组件不发起审批请求**：`ConfirmationAction` 只是 `Button`，`onClick` 由调用方绑定（通常是 `addToolApprovalResponse` 之类，属调用方职责）。源码内没有 `addToolApprovalResponse` / `sendMessage` 等调用（grep 无命中）。
- 依赖 `registryDependencies` 的 `alert`、`button`。

### 7.5 最小用法

registry 内**未查到**示例。由源码可确认的调用方式：

```tsx
<Confirmation approval={part.approval} state={part.state}>
  <ConfirmationTitle>Allow running this tool?</ConfirmationTitle>
  <ConfirmationRequest>该工具请求执行</ConfirmationRequest>
  <ConfirmationAccepted>已批准，正在执行</ConfirmationAccepted>
  <ConfirmationRejected>已拒绝</ConfirmationRejected>
  <ConfirmationActions>
    <ConfirmationAction onClick={() => approve(part.approval.id, false)}>拒绝</ConfirmationAction>
    <ConfirmationAction onClick={() => approve(part.approval.id, true)}>批准</ConfirmationAction>
  </ConfirmationActions>
</Confirmation>
```

---

## 8. context

出处：`files[0].path = registry/default/ai-elements/context.tsx`。

### 8.1 导出清单

`Context`（L45）、`ContextTrigger`（L107）、`ContextContent`（L131）、`ContextContentHeader`（L143）、`ContextContentBody`（L182）、`ContextContentFooter`（L194）、`ContextInputUsage`（L253）、`ContextOutputUsage`（L293）、`ContextReasoningUsage`（L333）、`ContextCacheUsage`（L373）；
types：`ContextProps`（L43）、`ContextTriggerProps`（L105）、`ContextContentProps`（L129）、`ContextContentHeaderProps`（L141）、`ContextContentBodyProps`（L180）、`ContextContentFooterProps`（L192）、`ContextInputUsageProps`（L251）、`ContextOutputUsageProps`（L291）、`ContextReasoningUsageProps`（L331）、`ContextCacheUsageProps`（L371）。
文件内部：`ModelId`（L22）、`ContextSchema`（L24，未导出）、`ContextContext`（L31）、`useContextValue`（L33，未导出）、`ContextIcon`（L64，未导出）、`TokensWithCost`（L232，未导出）、常量 `PERCENT_MAX=100`/`ICON_*`（L16-20）。

### 8.2 精确 props 类型（token 字段，原文抄录）

```tsx
// L16-22
const PERCENT_MAX = 100;
const ICON_RADIUS = 10;
const ICON_VIEWBOX = 24;
const ICON_CENTER = 12;
const ICON_STROKE_WIDTH = 2;

type ModelId = string;

// L24-29  —— token 字段全在这里
interface ContextSchema {
  usedTokens: number;
  maxTokens: number;
  usage?: LanguageModelUsage;
  modelId?: ModelId;
}

// L43
export type ContextProps = ComponentProps<typeof HoverCard> & ContextSchema;

// L105 / L129 / L141 / L180 / L192 / L251 / L291 / L331 / L371
export type ContextTriggerProps = ComponentProps<typeof Button>;
export type ContextContentProps = ComponentProps<typeof HoverCardContent>;
export type ContextContentHeaderProps = ComponentProps<"div">;
export type ContextContentBodyProps = ComponentProps<"div">;
export type ContextContentFooterProps = ComponentProps<"div">;
export type ContextInputUsageProps = ComponentProps<"div">;
export type ContextOutputUsageProps = ComponentProps<"div">;
export type ContextReasoningUsageProps = ComponentProps<"div">;
export type ContextCacheUsageProps = ComponentProps<"div">;
```

**token 字段的确切语义（由源码用法确认，而非猜测）：**

| 字段 | 类型 | 用法出处 |
| --- | --- | --- |
| `usedTokens` | `number`（必填） | 环形进度：`usedPercent = usedTokens / maxTokens`（L67、L109、L149）；Header 的 `used`（L154-156） |
| `maxTokens` | `number`（必填，**作除数**） | L67/L109/L149/L159 |
| `usage.inputTokens` | `LanguageModelUsage["inputTokens"]` | `ContextInputUsage`：`const inputTokens = usage?.inputTokens ?? 0;`（L259），footer 成本 `input: usage?.inputTokens ?? 0`（L204） |
| `usage.outputTokens` | 同上 | `const outputTokens = usage?.outputTokens ?? 0;`（L299）、L205 |
| `usage.reasoningTokens` | 同上（**在 `ai@6.0.289` 已标记 `@deprecated`**，新写法为 `outputTokenDetails.reasoningTokens`，见 `dist/index.d.ts` L311-314） | `const reasoningTokens = usage?.reasoningTokens ?? 0;`（L339） |
| `usage.cachedInputTokens` | 同上（**同样 `@deprecated`**，新写法 `inputTokenDetails.cacheReadTokens`，同文件 L315-317） | `const cacheTokens = usage?.cachedInputTokens ?? 0;`（L379） |
| `modelId` | `ModelId = string`（可选） | 传给 `tokenlens` 的 `getUsage({ modelId, usage })` 计算 `costUSD?.totalUSD`（L200-208、L269-274、L309-313、L349-353、L389-393） |

`LanguageModelUsage` 的完整字段定义（`ai@6.0.289` `dist/index.d.ts` L266-329）：`inputTokens`、`inputTokenDetails.{noCacheTokens, cacheReadTokens, cacheWriteTokens}`、`outputTokens`、`outputTokenDetails.{textTokens, reasoningTokens}`、`totalTokens`，以及被标记 `@deprecated` 的 `reasoningTokens?`、`cachedInputTokens?`、`raw?`。

### 8.3 运行中 / 完成态的条件渲染（关键判断原文）

**没有 `isStreaming` / `state` / `status` 判断**（本文件是 token 用量仪表盘，属于典型的**结果展示 / 状态展示**组件）。存在的是三处「为空则不渲染」和「有 children 则完全交给 children」：

```tsx
// L64-68  ContextIcon：环形进度由 usedTokens/maxTokens 计算，不做空值保护
  const circumference = 2 * Math.PI * ICON_RADIUS;
  const usedPercent = usedTokens / maxTokens;
  const dashOffset = circumference * (1 - usedPercent);
```

```tsx
// L199-208  Footer 成本：modelId 缺失 => costUSD undefined => 显示 $0.00
  const costUSD = modelId
    ? getUsage({
        modelId,
        usage: {
          input: usage?.inputTokens ?? 0,
          output: usage?.outputTokens ?? 0,
        },
      }).costUSD?.totalUSD
    : undefined;
```

```tsx
// L261-267  ContextInputUsage：先让位给 children，token 为 0 则不渲染
  if (children) {
    return children;
  }

  if (!inputTokens) {
    return null;
  }
```

`ContextOutputUsage`（L301-307）、`ContextReasoningUsage`（L341-347）、`ContextCacheUsage`（L381-387）是**同样的两段判断**（`if (children) return children;` + `if (!xxxTokens) return null;`），只有 token 字段不同。

另有两处默认值填充：

```tsx
// L59  Context 固定 hover 无延迟
      <HoverCard closeDelay={0} openDelay={0} {...props} />
```

```tsx
// L45-51  Context = HoverCard 容器 + ContextSchema 解构
export const Context = ({ usedTokens, maxTokens, usage, modelId, ...props }: ContextProps) => {
```

### 8.4 消费的 UIMessage part 类型 / 对 `useChat` 字段的要求

- 导入：`import type { LanguageModelUsage } from "ai";`（L11）与运行时 `import { getUsage } from "tokenlens";`（L14）。
- **不消费任何 `UIMessage` part**，也不要求 `useChat` 字段；它的输入是「一次请求/会话的用量对象」。来源语义上对应 AI SDK 的 `message.metadata` 或 `useChat()` 的 usage（例如 `LanguageModelUsage`），但组件只接收 `usage?: LanguageModelUsage`，**具体从哪取由调用方决定**（组件源码未约束）。
- 依赖 `registryDependencies` 的 `button`、`hover-card`、`progress`；外部包 `tokenlens`（价格表）。

### 8.5 最小用法

registry 内**未查到**示例。由源码可确认的调用方式：

```tsx
<Context usedTokens={usage?.totalTokens ?? 0} maxTokens={128000} usage={usage} modelId="openai/gpt-4o">
  <ContextTrigger />
  <ContextContent>
    <ContextContentHeader />
    <ContextContentBody>
      <ContextInputUsage />
      <ContextOutputUsage />
      <ContextReasoningUsage />
      <ContextCacheUsage />
    </ContextContentBody>
    <ContextContentFooter />
  </ContextContent>
</Context>
```

---

## 9. 横向对照表

### 9.1 是否运行时组件（依据「源码里是否有状态判断」）

| 组件 | 源码内是否存在状态判断 | 判断表达式（原文关键片段） | 判定 |
| --- | --- | --- | --- |
| conversation | 有（滚动位置） | `!isAtBottom && (`（L85） | 运行时（滚动行为） |
| message | 仅 `isAnimating` 透传 | `nextProps.isAnimating === prevProps.isAnimating`（L339） | 展示 + 通过 Streamdown 承接流式 |
| reasoning | 有（最完整） | `if (isStreaming && !isOpen && !isExplicitlyClosed)`（L102）；`!isStreaming && isOpen && !hasAutoClosed`（L112）；`if (isStreaming \|\| duration === 0)`（L158） | **运行时** |
| tool | 有（state 查表） | `getStatusBadge(state)`（L96）；`if (!(output \|\| errorText)) return null;`（L141） | **运行时状态展示** |
| task | 无 | — | 纯展示 |
| sources | 无（只有 children 兜底） | `{children ?? (...)}`（L35） | 纯展示 |
| confirmation | 有（审批态机） | `state !== "approval-requested"`（L98/L158）；`!approval?.approved`（L116）；`approval?.approved !== false`（L138） | **运行时（审批流程）** |
| context | 无（只有空值短路） | `if (!inputTokens) return null;`（L265） | 纯展示 |

### 9.2 组件 ↔ UIMessage part 对应关系

| 组件 | 源码中出现的 part 相关字面量 | 实际消费字段 | 是否 import `ai` |
| --- | --- | --- | --- |
| conversation | `part.type === "text"`（L105） | `UIMessage.parts[].text`、`UIMessage.role`（L120） | 是（type only，L5） |
| message | 无 | 无（只收 `from: UIMessage["role"]`） | 是（type only，L19） |
| reasoning | 无 | 无（收 `isStreaming: boolean`） | **否** |
| tool | `"dynamic-tool"`（L83）、`"input-streaming"` 等 7 态（L47-65） | `type`/`state`/`input`/`output`/`errorText`/`toolName` | 是（type only，L10） |
| task | 无 | 无 | **否** |
| sources | 无 | 无（收 `count`/`href`/`title`） | **否** |
| confirmation | `"input-streaming"`、`"input-available"`、`"approval-requested"`、`"approval-responded"`、`"output-denied"`、`"output-available"`（L70、L98、L117-119、L139-141、L158） | `state`、`approval.{id,approved,reason}` | 是（type only，L6） |
| context | 无 | `LanguageModelUsage` 对象（与 part 无关） | 是（type only，L11） |

**未在源码中出现的 part 类型**（`grep` 无命中）：`source-url`、`source-document`、`data-*`、`file`、`step-start`。即这些组件的 part 归集工作**全部留给调用方**。

### 9.3 明确「未查到」的项

1. **最小用法/示例代码**：8 个 registry JSON 的 `files[].content` 与 JSON 顶层字段中均无 `@example` / usage / demo 文件（仅 `description` 一句，如 `"AI-powered tool component."`）。官方示例应查阅 `https://elements.ai-sdk.dev` 文档站，本次调研范围（已下载的 registry 原文）内**未查到**。
2. **`Streamdown` 的完整 props**（`MessageResponseProps` 的真实字段）：本地未下载 `streamdown` 包，只从 memo 比较器确认存在 `children` 与 `isAnimating`（L337-339）。
3. **`StickToBottom` / `StickToBottom.Content` 的完整 props**（`ConversationProps` / `ConversationContentProps` 的真实字段）：`use-stick-to-bottom` 包未下载，仅确认组件内使用了 `initial`、`resize`、`role` 与上下文值 `isAtBottom`、`scrollToBottom`（L16-18、L78）。
4. **conversation 之外的组件是否在别处（如 `prompt-input` / `queue`）被组合使用**：不属本次 8 个文件范围，未查。
5. 附带说明：同目录下 `reg-actions.json`、`reg-loader.json`、`reg-response.json` 的内容分别是 `{"error":"Component \"actions\" not found."}`、`{"error":"Component \"loader\" not found."}`、`{"error":"Component \"response\" not found."}`，即这三个 registry 端点不存在对应组件（`response` 功能已并入 `message` 的 `MessageResponse`/`MessageContent`）。

---

## 10. 对「哪些组件是运行时用、哪些是结果展示」的最终判断

- **运行时（承载流式/审批过程）**：`reasoning`（`isStreaming` 驱动自动展开、自动收起、耗时与文案）、`tool`（`state` 七态驱动徽标与图标，`input-streaming`/`input-available` 即运行中）、`confirmation`（`state` + `approval.approved` 驱动请求/通过/拒绝三态）、`conversation` 的滚动容器（自动吸底 + `isAtBottom` 决定滚动按钮）。
- **结果展示**：`task`、`sources`、`context`，以及 `message` 的骨架组件（`Message`/`MessageContent`/`MessageActions`/`MessageToolbar`）；`message` 的 `MessageResponse` 通过 `isAnimating` 透传承接流式渲染，属于边界组件。
- **关键判断全部来自调用方**：这 8 个组件**没有任何一个调用 `useChat`**，也没有任何一个内部读取 `message.parts`（唯一例外是 conversation 导出的纯函数 `messagesToMarkdown`）。这意味着上层必须自己遍历 `parts` 并按 `part.type`（`text` / `reasoning` / `tool-<name>` / `dynamic-tool` / 可能的 `source-url`、`data-*`）把运行时状态映射成这里列出的 props。
