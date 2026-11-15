# model-gateway 设计（评审稿 v0）

> **落地进度（2026-11-15）**：P4.1/P4.2/P4.3 已落地 —— `apps/model-gateway`（9992，catalog +
> `openai-compatible` / `deepseek` / `ollama` / `anthropic` 四个适配器）+ runtime 的网关目录客户端与
> `RuntimeModelResolver` 端口；用本机 Ollama 跑通流式/非流式（含 `reasoning_content`、usage、成本）。
> 同批落地：`model_gateway_usage` 逐请求流水（价格快照 / 成本 / 归因头）、`ai_provider_keys` key 池
> + Redis 冷却/额度、main 的 key CRUD API、`ai.model.changed` 缓存失效。
> 同批落地：main 的「同步 / 连通性测试」已改为经网关 `/internal/providers/*`（供应商交互与明文 key 只在网关）。
> **未做**：生图（P4.4）、key 加密（本轮明确不做）。
> **runtime 的 `modules/ai-model/**` 已删除**（生产唯一模型来源是网关目录）。
>
> 状态：**草案，待评审**（2026-11-15）。本文是 [distributed-ai-architecture.md](distributed-ai-architecture.md)
> P4「模型网关」的细化：只回答「怎么搞」，不含实现。**拍板项集中在 §13**，评审时逐条确认。
>
> 相关的落地现状：`apps/main`（9989）/ `apps/agent-runtime`（9990）/ `apps/tool-gateway`（9993）/
> `apps/tool-worker`（9994）已落地，`model-gateway`（9992）**未建**；目前模型调用由 runtime 直连供应商，
> `ai-model` 模块在 main / runtime 各有一份（见 [main-runtime-dedup.md](main-runtime-dedup.md)）。

## 0. 一页结论

**定位**：第 5 个无状态服务 `apps/model-gateway`（9992，只在内网）。它是**唯一持有供应商 key 和上游端点决策**的进程，同时是**计量点**和**准入点**。

**三件事**：

1. **路由转发**：对 runtime 暴露一套 canonical OpenAI 兼容接口，内部实现 **4 套上游协议适配器**
   （`openai-compatible` / `deepseek` / `anthropic` / `ollama`，见 §3.7），按供应商的 `protocol` 选适配器；
2. **消耗统计**：逐请求落 `model_gateway_usage`（真实调用口径，含重试与非 run 调用），按价格表算成本；
3. **key 控制与配额**：上游 key 池（多 key / 冷却 / 轮换）+ 入站配额（RPM / TPM / 日预算）。

**归属变化**（建成后）：

| 现在 | 目标 |
| --- | --- |
| runtime 读 `ai_providers` / `ai_models`、持 key、决定供应商端点 | runtime 只调 `ModelClient`，不读配置表、不持 key |
| runtime 的 `ai-model` 模块（约 1840 行，与 main 重复） | **已删除**，只剩网关目录客户端 + `RuntimeModelResolver` |
| main 的 `ai-model`：CRUD + 同步 + 测试 + seed | 保留（配置面不动），key 管理扩成 key 池 |
| 用量只有 `runs.usage` + `ai_usage_daily`（业务口径） | 增加 `model_gateway_usage`（调用口径），两者对账、不混表 |
| 文件：runtime 从 OSS 取 → inline data URL | 输入文件先保持 inline；产物由执行侧落 OSS + `ai_files` |

## 1. 背景与目标

### 1.1 为什么现在做

- 设计稿定了五服务，P4 一直没建；`ai-model` 因此在 main / runtime 各一份，已经出现分叉风险；
- runtime 直接持有供应商明文 key（`ai_providers.api_key` 明文入库，2026-10-01 决定），任一 runtime 副本泄露即全部供应商账号失守；
- 供应商会持续增加（Kimi / 豆包 / 千问 / Claude / Ollama …），如果每加一家都改 runtime 的 SDK 与端点，边界会重新散掉；
- 成本目前只有 token 数（`runs.usage`），**没有钱**；重试、标题生成、记忆抽取这些非 run 调用完全没计量。

### 1.2 目标（可验收）

- runtime 不再 import `modules/ai-model`，不再读 `ai_providers` / `ai_models` 的任何列（含 key）；
- 网关内部实现 4 套协议适配器（openai-compatible / deepseek / anthropic / ollama），新接一家供应商：**只改配置 + 画像表**，runtime 零改动；
- 每次模型调用（含失败重试）都有一条 `model_gateway_usage`，能按 run / 用户 / 模型 / key 汇总；
- 成本可追溯：价格有版本，未知价格显式 `null`，不估算；
- 流式对话首 token 延迟相比现在（直连）增加 < 100ms（同机内网实测）。

### 1.3 非目标（本期不做）

- 不做模型微调 / embedding / rerank 的网关（当前业务没用到；接口预留扩展位）；
- 不做对外公开的 OpenAI 兼容 API（租户 key 是 P4.3c，按需）；
- 不做基于成本的自适应路由 / 自动降级（先保留"备用模型"配置位，不实现）；
- 不做视频 / 长音频的流式上传（图片够用，视频另立方案）。

## 2. 职责与数据归属

| 进程 | 职责 | 写 | 读 |
| --- | --- | --- | --- |
| `main` | 配置面：供应商 / 模型（含价格）/ key 的 CRUD；用量 / 成本查询页；同步 / 连通性测试**改为调网关**（P4.2b 后不再直连供应商） | `ai_providers`、`ai_models`、`ai_provider_keys` | **全部**（含 `model_gateway_usage`，对账与页面） |
| `model-gateway` | 路由 / 转发 / 4 套协议适配 / 列模型同步 / 连通性测试 / 计量 / key 选择 / 配额 | `model_gateway_usage`（唯一写方） | `ai_providers`、`ai_models`、`ai_provider_keys`（只读，受限 DB 角色） |
| `agent-runtime` | agent loop、上下文、Mastra | `runs` / `timelines` / `ai_memories` / `ai_files`（执行侧） | 模型元数据经 gateway catalog；**不读配置表** |

- 配置变更通知：main 写库后发 Redis EventBus `ai.model.changed`，网关订阅失效缓存；事件 at-most-once，**缓存 TTL 兜底**（默认 30s）。
- 网关**不写** `ai_files`、不碰 `runs/timelines`，也不做控制面 CRUD。
- 网关的 DB 角色最小化：4 张配置表只读 + `model_gateway_usage` 只写。

## 3. 接口设计

### 3.1 canonical 对话接口

**推荐形态**：路径带模型 id，网关不解析请求体。

```
POST http://model-gateway:9992/v1/models/{modelId}/chat/completions
```

- runtime 建模型实例时 `baseURL = ${MODEL_GATEWAY_URL}/v1/models/${modelId}`，AI SDK 自动拼 `/chat/completions`；
- body 里的 `model` 保持**供应商原生 modelKey** 原样，网关不重写；
- 请求体流式转发（`duplex: 'half'`），不 `JSON.parse`（多模态图片 base64 可能几 MB）；
- 响应体**字节透传**（见 §4），只有旁路解析。

**备选**（不推荐）：单入口 `/v1/chat/completions` + `model=providerSlug/modelKey`。需要解析 body 或靠 header 路由，收益是把 URL 变短，代价是每次请求多一次 JSON 解析与大 body 处理。

### 3.2 catalog / resolve

runtime 需要模型元数据（**不含 key**）：`contextWindow`（上下文预算）、`mode` / `inputModalities`（附件校验）、`providerKind`（选适配层）。

```
GET /internal/catalog            → { code: 0, data: { models: [{ id, modelRef, modelKey, providerId,
                                                providerSlug, providerKind, contextWindow, mode,
                                                inputModalities, outputModalities }],
                                     defaultModelId } }
```

内部 JSON 统一套 `{ code, data }` 信封（与公网一致）；`/v1/**` 模型协议保持 OpenAI 原始 JSON / SSE，
`/healthz` `/readyz` 探针保持裸 JSON。

- 默认模型选择（`provider.created_at` → `model_key` 升序）与错误语义（3402 / 3404 / 3406）由网关负责；
- runtime 进程内缓存 30s，`ai.model.changed` 事件失效；
- `/agent/models` 这类**控制面**查询仍走 main（它已有 `AiModelService`），runtime 只用 catalog 做运行期解析。

### 3.3 生图 / 异步任务接口（P4.4）

生图不是 chat completions：有同步返回 URL/base64 的、有异步任务轮询的（豆包 Seedream、万相）、耗时秒级到分钟级、按张/像素/秒计费。

```
POST /v1/images/generations        # 同步：回二进制流 + 元数据头（见 §5.2）
POST /v1/jobs   → { jobId }        # 异步：统一轮询型供应商
GET  /v1/jobs/{id}                 # status / result（完成后回二进制流）
DELETE /v1/jobs/{id}               # 取消（尽力而为）
```

- **轮询在网关内部完成**（推荐）：runtime 只看到一次长等待（默认 5min，可配）+ 最终字节流；签名、轮询间隔、结果字段这些供应商差异收在网关。
- 备选：runtime 轮询网关 job（连接短、可断点，但 runtime 多一套任务状态机）。
- 进度展示：后续可按需加 SSE 进度帧，不在首版。

### 3.4 归因与鉴权头

| Header | 方向 | 用途 |
| --- | --- | --- |
| `x-internal-token` | runtime → gateway | 服务间鉴权（`MODEL_GATEWAY_TOKEN`，与 `AGENT_INTERNAL_TOKEN` 分开） |
| `x-billy-run-id` | runtime → gateway | 用量归因到 run（标题 / 记忆抽取等非 run 调用可缺省） |
| `x-billy-conversation-id` | runtime → gateway | 归因到会话 |
| `x-billy-identity` | runtime → gateway | 归因到用户 / 管理员（计费与配额） |
| `traceparent` | 全链路 | OTel 链路 |

runtime 用 `createOpenAICompatible({ baseURL, apiKey: token, headers })` 显式注入（不再走 Mastra 的 `resolveModelConfig`，它只认 `id/url/apiKey`）；这意味着 runtime 要新增 **`@ai-sdk/openai-compatible` 直接依赖**（目前只在 Mastra 内部被引用），版本跟随 `ai@7`。

### 3.5 错误契约

- 网关对 runtime 的响应：HTTP 状态码 + **OpenAI 风格 error body**，并带 `x-billy-error-code` 便于精确映射；
- 业务错误码沿用 `AppErrorCodes`，新增（编号待定，34xx 段当前最大 3423）：

| 场景 | 建议 code | HTTP |
| --- | --- | --- |
| 网关不可用 / 熔断 | `ModelGatewayUnavailable`（建议 3424） | 503 |
| 配额超限（RPM/TPM/日预算） | `ModelQuotaExceeded`（建议 3425） | 429 |
| 无可用 key（全部冷却 / 未配置） | `ModelKeyExhausted`（建议 3426） | 503 |
| 上游首字节超时 | 复用 `AgentFailed` 3302 或新增 3427 | 504 |

- 3402 / 3404 / 3405 / 3406 的语义保持不变，由 catalog / resolve 阶段返回，runtime 直接透传给前端（现有提示文案不用改）。

### 3.6 runtime 侧怎么接线（不改 Mastra 的调用方式）

**agent loop 不变**：仍然是 `mastra.getAgent(key).stream(messages, { model })`，`model` 仍然是一个 AI SDK 模型实例；变的只是**这个实例怎么造**。

```ts
// runtime/mastra/agent.adapter.ts（改成指向网关）
const model = createOpenAICompatible({
  name: 'billy-gateway',
  baseURL: `${MODEL_GATEWAY_URL}/v1/models/${modelId}`,
  apiKey: MODEL_GATEWAY_TOKEN,
  headers: {
    'x-billy-run-id': runId,
    'x-billy-conversation-id': conversationId,
    'x-billy-identity': identity,
  },
  includeUsage: true, // 让上游在流尾带 usage（计量用）
}).chatModel(modelKey)

await agent.stream(messages, { model, ... })
```

- **不用** Mastra 的 `resolveModelConfig` / ModelRouter（`defaultGateways` / `MastraModelGateway`）：它按 `id/url/apiKey` 决定供应商端点、带不了自定义 header（归因要用），而且会把「网关接口」绑成 Mastra 专属协议——main / tool-worker 将来也要用同一套接口。设计稿 D8 的原话就是「不让 Mastra 决定 provider 端点」。
- 顺带一个事实：Mastra 内部对多数供应商本来也是 `createOpenAICompatible({ baseURL, apiKey, headers }).chatModel(id)`（`@mastra/core/dist/netlify-*.js:42983`），我们只是把 `baseURL` 换成网关、把 key 换成内部令牌。
- **DeepSeek 也走网关 canonical**：思考字段由网关的 `deepseek` 适配器负责保留（见 §3.7），runtime 不再需要 `createDeepSeek`；原先的 S0 spike 降级成回归测试（验证 `reasoning_content` 经网关后仍能被 AI SDK 识别）。仅在回退模式下才用官方工厂 + `baseURL` 指网关。
- 装配期给 `new Agent({ model })` 的占位配置改成固定指向网关（`id + url + 内部令牌`），不再从信封取 key / url。
- **回退**：部署上一版镜像（runtime 的 `ai-model` 已删，进程内不再有直连回退）；`agent.adapter` 里保留的直连构造只服务测试的 mock 上游。

runtime 侧随之删改：`RuntimeModel` 去掉 `apiKey` / `baseURL`（改带我们的 `modelId`）、`model-decision.ts` 退役（或只留回退分支）、`agent.adapter.ts` 换成上面的构造、`chat.service.ts` 的解析改问 catalog、删除 `modules/ai-model/**`；新增 `@ai-sdk/openai-compatible` 直接依赖（版本跟随 `ai@7`），`@ai-sdk/deepseek` 可从 runtime 依赖里移除。

### 3.7 协议适配器：4 套

**决定（2026-11-15）**：网关内部实现 4 套**上游协议**适配器 —— `openai-compatible` / `deepseek` /
`anthropic` / `ollama`；**对外仍是一套 canonical OpenAI 接口**（runtime 只留一个 adapter）。
「加一家供应商」= 选协议 + 填一行画像，**不改 runtime、不新增协议代码**。

**术语拆开**（当前代码里只有 `kind`，没有 `protocol`）：

| 概念 | 例子 | 用途 |
| --- | --- | --- |
| `kind`（厂商） | `moonshot` / `volcengine` / `dashscope` / `deepseek` / … | 展示、默认地址画像（`PROVIDER_ENDPOINTS`） |
| `protocol`（线路协议） | `openai-compatible` / `deepseek` / `anthropic` / `ollama` | 选哪个适配器 |

`ai_providers` 新增 `protocol` 列（默认按 `kind` 推导，旧数据迁移回填）；两者分离后，
"换协议不改厂商画像、加厂商不加协议代码"。

| 适配器 | 覆盖 | 上游形态 | 关键差异 |
| --- | --- | --- | --- |
| `openai-compatible` | Kimi / 豆包 / 千问 / 智谱 / 硅基 / MiniMax / 千帆 / 混元 / 阶跃 / 星火 / 自建 | `POST {base}/chat/completions`，SSE | 路径与鉴权按 kind 画像；`reasoning_content` / `reasoning` 原样透传；usage 字段各家写法不同 |
| `deepseek` | DeepSeek 官方 | `POST https://api.deepseek.com/chat/completions`（无 `/v1`），SSE | `reasoning_content` 双向保留；**请求带 `tools` 时每条 assistant 消息都必须带 `reasoning_content`**（官方文档：工具调用的后续请求「必须完整回传」，即使该轮没实际调用工具），网关补空串兜底——判据是「带不带 tools」，与 thinking / reasoning_effort / 模型名无关（2026-11-15 实测）；`prompt_cache_hit_tokens` 映射为缓存读 |
| `anthropic` | Claude | `POST {base}/v1/messages`，SSE **事件流** | 结构完全不同：`system` 顶层、`max_tokens` 必填、`tool_use` / `tool_result` 块、`thinking` 块、图片 base64、`cache_read_input_tokens`；必须逐事件翻译 |
| `ollama` | 本地 / 自建 Ollama | `POST {base}/api/chat`，**NDJSON（不是 SSE）** | 每行一个 JSON；`message.thinking` / `images` base64 / `tool_calls`；usage 是 `prompt_eval_count` / `eval_count`（无缓存字段）；模型列表走 `/api/tags`、窗口走 `/api/show` |

**适配器接口**（canonical 结构放 `@repo/contracts`，实现在 `apps/model-gateway/src/protocols/<protocol>/`）：

```ts
interface ProtocolAdapter {
  buildRequest(canonical: ChatRequest, ctx: ProviderContext): UpstreamRequest
  translateStream(upstream: ReadableStream<Uint8Array>): AsyncIterable<CanonicalChunk>
  mapUsage(raw: unknown): GatewayUsage
  mapError(status: number, body: unknown): GatewayError
  listModels?(ctx: ProviderContext): Promise<RemoteModel[]>
}
```

- `openai-compatible` / `deepseek` 可以**字节透传**（只旁路解析 usage）；`anthropic` / `ollama` 必须解析再编码成 OpenAI SSE；
- canonical 是 **OpenAI Chat Completions + 扩展字段**：`reasoning_content`（思考）、工具调用沿用 `tool_calls`、缓存控制字段预留；
- **所有供应商交互都收进网关**：除对话外，「列模型（同步）」和「连通性测试」也是协议相关
  （Ollama 用 `/api/tags`、Anthropic 用 `x-api-key`），所以 main 的同步 / 测试改为调网关内部接口，
  `provider-adapters.ts` 随后从 main 移除（P4.2b）。**供应商明文 key 只出现在网关**，main 连解密都不需要。

## 4. 流式转发

### 4.0 方向澄清：谁发、谁收

SSE 是 **HTTP 响应**的一种（`Content-Type: text/event-stream`），方向固定为 **服务端 → 客户端**；
客户端发起的仍然是普通 HTTP 请求（JSON body），不存在「客户端给服务端发 SSE」这种事。

链路上的角色（每一跳都是「左边是 client，右边是 SSE server」）：

| 跳 | client（发请求） | server（回 SSE） | 说明 |
| --- | --- | --- | --- |
| ③ | 浏览器 | `main` | 真正的用户侧 SSE |
| ② | `main` | `agent-runtime` | `POST /internal/agent/chat/stream`；Kafka 模式下 main 只 drain 这个响应，内容以 Kafka 为准 |
| ① | `agent-runtime` | `model-gateway` | `POST /v1/models/{id}/chat/completions`，JSON 请求、SSE 响应 |
| ①' | `model-gateway` | 供应商 | gateway 作为 client 调上游，拿到上游的 SSE 响应 |

所以：**runtime 不向 gateway 发 SSE**。runtime 发的是一个普通 JSON POST（`stream: true`），
gateway 在同一个 HTTP 连接的**响应体**里把字节流写回去。一个连接上：请求体单向（JSON）、
响应体单向（SSE），半双工。

```
runtime (client)                      gateway (server)                    供应商
   │                                      │                                 │
   │── POST /v1/models/x/chat/completions │                                 │
   │   {stream:true, messages:[...]}      │                                 │
   │                                      │── POST 上游（注入 key）────────>│
   │                                      │<── 200 text/event-stream ───────│
   │<── 200 text/event-stream（pipe）─────│                                 │
   │   data: {...}\n\n                    │                                 │
   │   data: [DONE]\n\n                   │                                 │
   │                                      │                                 │
   └─ AI SDK 解析 SSE → UI chunks          └─ 只搬字节（旁路解析 usage）      │
```

用 curl 类比这一跳：

```bash
curl -N -X POST "http://gateway:9992/v1/models/{id}/chat/completions" \
  -H "x-internal-token: $TOKEN" -H "content-type: application/json" \
  -d '{"stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

发出去的是 JSON，收回来的是 `data: ...` 帧 —— **gateway 是服务端，runtime 是客户端**。

### 4.1 状态机

```
请求进来
  ├─ 鉴权 / 配额 / key 选择 → 失败：直接 JSON 错误（未写头）
  ├─ fetch 上游（不写头）
  │    ├─ 首字节前失败 → 换 key / 重试（≤2 次）→ 仍失败：透传上游错误（未写头）
  │    └─ 收到第一块 → writeHead(200) + flushHeaders → 开始 pipe
  └─ 流中：
       ├─ 每块重置 idle timer（默认 180s）
       ├─ 旁路解析 usage / error（不阻塞 pipe）
       ├─ 客户端断开 → abort 上游
       └─ 上游断流 → 结束响应 + 记账
```

### 4.2 必须守的点

| 点 | 做法 | 不做的后果 |
| --- | --- | --- |
| 首字节前不写头 | 等到第一个 chunk 再 `writeHead`；首字节超时 120s | 上游 429 后已回 200，前端拿到空流 |
| 首字节前可重试 | 换 key / 同供应商备用 key，≤2 次 | 偶发 429 直接失败 |
| 首字节后不重试 | 只认这一条流；断流即结束 | 重复吐字 / 重复计费 |
| 空闲超时 | 每块重置 180s 计时器；超时 abort | 挂死连接占满网关 |
| 客户端断开 | `res.on('close')` → `AbortController.abort()` | 上游继续烧 token |
| 背压 | `pipe` 或 `write` 返回 false 时等 `drain` | 慢消费者导致内存爆炸 |
| 不吞 `[DONE]` | 原样透传 | AI SDK 等不到结束 |
| 不压缩 | 上游 `accept-encoding: identity`；网关禁用 compression | 旁路解析要解压，且容易缓冲 |
| 不整包缓冲 | 请求 `duplex: 'half'`；响应 reader/pipe；旁路解析行长上限 1MB | 大图/长会话直接 OOM |
| keep-alive | 上游用 keep-alive dispatcher；`requestTimeout` 设 0，`headersTimeout` > 首字节超时 | 长连接被 Node 默认超时切断 |

### 4.3 旁路解析（计量）

- 独立于 pipe 的增量 SSE 解析器：按 `\n\n` 分帧，只取 `usage`、`error`、首 token 时间、帧数；
- 流式 usage 来自尾包（AI SDK 已带 `stream_options.include_usage`，否则 `runs.usage` 不会有数）；
- 记账异步批量写，**绝不 await 在 pipe 路径上**；进程崩溃丢失的当日流水由对账任务兜底（P4.3b）。

### 4.4 协议归一：哪些要翻译

| 协议 | 流处理 |
| --- | --- |
| `openai-compatible` | 字节透传；只旁路取 usage / error |
| `deepseek` | 字节透传；**请求侧要补 `reasoning_content`**（历史 assistant 消息，V4 必填，空串兜底），响应侧原样透传 |
| `anthropic` | 逐事件翻译再编码成 OpenAI SSE（下表） |
| `ollama` | NDJSON 逐行解析 → 重编码成 OpenAI SSE（`data: ...\n\n`） |

Anthropic 事件映射：

| Anthropic 事件 | OpenAI SSE 帧 |
| --- | --- |
| `message_start` | `choices[0].delta.role = assistant` |
| `content_block_delta(text)` | `choices[0].delta.content` |
| `content_block_delta(thinking)` | `choices[0].delta.reasoning_content` |
| `content_block_start(tool_use)` / `input_json_delta` | `choices[0].delta.tool_calls[].function.arguments`（分片原样） |
| `message_delta` | `finish_reason` + `usage` |
| `message_stop` | `data: [DONE]` |

约束：① 每个事件立即转出，不攒包（AI SDK 按 `\n\n` 分帧）；② 工具参数是分片 JSON，原样分片；
③ 思考统一写 `reasoning_content`（Mastra 内置 openai-compatible 认它，`netlify-*.js:3538`）；
④ Ollama 的 NDJSON 行没有 `data:` 前缀，必须由网关补帧。

### 4.5 与 runtime → main 的流无关

runtime → main 是 **Kafka 事件流**（`app.agent.run.events`，key=runId），main 的 `AgentSseBridge` 按 clientId 写 SSE；网关只处理「供应商 → runtime」这一段字节流，不碰 UI 协议、不碰 Kafka。
取消链：浏览器断开 **不 abort run**（现有设计）；`/agent/run/stop` → runtime `abortSignal` → AI SDK abort → 网关检测断开 → abort 上游。

## 5. 文件与产物

> **原则**：对象存储 + `ai_files` 是文件的事实源；网关只做「模型请求/响应里的文件形态适配」，不存文件、不写 `ai_files`、不把字节塞进事件流。
> 现有口径：二进制只在 OSS，`timelines` 不存字节，单文件 5MB，附件单文件上限 2MB（`main.ts` 请求体 2mb）。

### 5.1 输入文件（进模型）

现状：前端预签名直传 OSS → 只把 key 带进请求 → runtime 按 key 取回 → 图片转 data URL、文本内联、PDF 先抽文字（[chat-attachment.service.ts](../../apps/agent-runtime/src/modules/ai/runtime/chat-attachment.service.ts)）。**服务间本来不传文件**。

| 方案 | 做法 | 评价 |
| --- | --- | --- |
| A（P4.2 先用） | runtime 照旧取 OSS → inline data URL → 网关透传 | 改动最小；base64 膨胀 33%、大图每轮重复传、受供应商 body 上限约束 |
| B（P4.5） | 请求里带 `billy://file/{id}`，网关按供应商能力取 OSS / 换 URL / 上传供应商 File API | 省带宽、可适配 Anthropic Files；网关需读 OSS + `ai_files`，权限面变大 |
| C（P4.5） | 网关加 `/v1/files` 上传换 `file_id`，请求引用 | 一份文件只传一次、可缓存；多一套上传 API 与 TTL |

限制：内网 OSS 的预签名 URL 供应商访问不到，**"把 URL 给供应商"只在供应商能出公网时成立**，通用做法仍是 data URL。

### 5.2 输出产物（生图）

**二进制绝不进 SSE / JSON / DB**（3MB 图片 → 4MB base64 经网关、runtime、Kafka、SSE、前端内存，不可接受）。

```
供应商 (url / b64 / 二进制)
  └─> model-gateway：统一成「二进制流 + 元数据头」返回
        └─> 执行侧（runtime 或 tool-worker）：收下 → 转存 OSS
              └─> FileService 写 ai_files（source='ai'）→ 得到 fileId / fileKey
                    └─> 时间线/工具结果只放文件引用（fileId、mediaType、bytes、宽高）
                          └─> 前端用 main 的 /agent/file/* 预签名 URL 展示
```

- 网关响应：`application/octet-stream` + `x-billy-file-name` / `x-billy-media-type` / `x-billy-width` / `x-billy-height` / `x-billy-provider-job-id`；
- 生成物必须落 OSS 后再给前端**短时预签名 URL**，不直接暴露供应商临时 URL；
- 现有 `ObjectStorage.putObject(body: Buffer)` 与 `FileService.submit`（从工作区文件读）都是**整包**：图片（≤20MB）可接受；视频/长音频需新增流式上传（不在本期）；
- 需要补 `FileService.submitBytes`（或等价入口）：把一段生成的字节登记为 `source='ai'` 的会话文件。

### 5.3 执行侧

| 阶段 | 执行侧 | 说明 |
| --- | --- | --- |
| 先跑通 | runtime 内一个 `image-generate` 工具/服务 | 与 run/timeline 同进程，直接 `FileService` 落库 |
| 收口 | tool-worker | 符合「能力工具全在 worker」；worker 调网关、落 OSS + `ai_files`，工具结果回 file 引用 |

网关两侧都不写数据库；`ai_files` 由执行侧写。

### 5.4 安全与限制

- 生成物大小上限（图片 20MB，可配）、mime 以服务端嗅探为准（不信供应商 Content-Type）；
- 供应商返回 URL 时由网关下载 → **host 白名单 + 禁止内网/环回地址**（SSRF）；
- 输入文件引用（方案 B）只能读本项目桶的 key 前缀；
- 产物生命周期沿用 `ai_files`：`source='ai'` 的对象随会话删除。

## 6. 计量与成本

### 6.1 `model_gateway_usage`（逐请求流水，网关唯一写）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(21) | 请求 id（nanoid） |
| `attempt` | int | 第几次上游尝试（重试也算行） |
| `run_id` / `conversation_id` | varchar(20) null | 归因（非 run 调用可空） |
| `identity_type` / `identity_id` | varchar(8) / varchar(20) null | user / admin |
| `provider_id` / `model_id` / `key_id` | varchar(20) | 调用了谁 |
| `stream` | bool | 是否流式 |
| `status` | varchar(8) | success / error / aborted / rejected |
| `http_status` / `error_code` | int / int null | 上游状态与我们的映射码 |
| `unit_type` | varchar(8) | token / image / second |
| `input_tokens` / `output_tokens` / `cache_read_tokens` / `cache_write_tokens` / `reasoning_tokens` | bigint null | **可空，不编造 0** |
| `units` | numeric null | 生图张数 / 视频秒数 |
| `cost_micros` | bigint null | 成本（微元），未知价格 → null |
| `price_snapshot` | jsonb null | 计算时用的单价快照（见 §6.2；不依赖版本表） |
| `ttft_ms` / `duration_ms` | int null | 首字节 / 总耗时 |
| `usage_missing` | bool | 上游没返回 usage |
| `created_at` | timestamp | 请求开始时间 |

### 6.2 价格：不版本化，请求时快照

**只有要算钱才需要价格；价格不需要版本表。** 成本在请求结束时算完就**冻结**在流水里，
历史准确性靠「请求时的单价快照」，不靠一张会被改动的价格表：

- 价格就放在 **`ai_models` 的列**上（`input_per_1m` / `output_per_1m` / `cache_read_per_1m` /
  `cache_write_per_1m` / `per_image` / `per_second`），管理员在「模型编辑」里填一次；
- 请求结束时把**当时的单价**写进 `model_gateway_usage.price_snapshot`（几个数字的 jsonb），
  同时算 `cost_micros`；
- 改价只影响之后的请求，**不回溯重算**（历史成本本来就是当时的价格，改价重算反而制造假账）；
- 未配置价格 → `cost_micros=null`、`price_snapshot=null`，页面显示「未配置价格」，不估算。

什么时候才需要「价格历史 / 版本表」（可选，不是首版）：

| 场景 | 是否真的需要 | 替代做法 |
| --- | --- | --- |
| 历史请求的成本可回溯 | 不需要 | 每行都有 `price_snapshot` |
| 价格配晚了 / 配错了，要重算 | 需要"能重算" | 用当前价重算并把结果标成 `adjusted`，不必记录历史价 |
| 按价格周期出账单 / 审计 | 需要 | 自动 append 一张 `ai_model_price_history`（main 保存时写，管理员不用维护） |
| 一客一价 / 促销价 / 多币种 | 需要完整版本表 | 只有对外计费才做；当前不做 |

**维护成本**：每个模型填 4–6 个数字（可留空 = 未配置），只在新增模型或厂商调价时动一次；
不想算钱就整列留空，网关照样统计 token / 张数 / 秒数（§6.1 的 `unit_type` 与 token 字段与价格无关）。

### 6.3 与 `ai_usage_daily` 的关系

| 口径 | 来源 | 用途 |
| --- | --- | --- |
| `runs.usage` + `ai_usage_daily` | 业务口径：一轮 run 的消耗（子 agent 已并入父 run） | 现有「AI 用量」页，**不动** |
| `model_gateway_usage` | 调用口径：每次真实上游调用（含重试、标题/记忆抽取等） | 成本与对账，新增页面 |

两者对不齐是正常的（子 agent 合并、重试、非 run 调用），做**对账视图**，不合并。

### 6.4 边界

- 流中断开：`status=aborted`，token 可能为 null；
- 上游不返回 usage：`usage_missing=true`，页面显示「—」，并计入监控；
- 重试：每次尝试一行，便于算清「重试烧了多少」；
- 崩溃丢失：P4.3b 增加「按 run 对账」任务，从 `runs.usage` 反查缺口。

### 6.5 各协议的用量字段映射

| 协议 | 输入 / 输出 | 缓存 | 推理 | 备注 |
| --- | --- | --- | --- | --- |
| `openai-compatible` | `prompt_tokens` / `completion_tokens` | `prompt_tokens_details.cached_tokens` | `completion_tokens_details.reasoning_tokens` | 字段缺失即 `null` |
| `deepseek` | `prompt_tokens` / `completion_tokens` | `prompt_cache_hit_tokens`（miss 记 `prompt_cache_miss_tokens`） | `completion_tokens_details.reasoning_tokens` | 缓存读字段名不同 |
| `anthropic` | `input_tokens` / `output_tokens` | `cache_read_input_tokens` / `cache_creation_input_tokens` | 思考已含在 `output_tokens` | 无独立推理字段 |
| `ollama` | `prompt_eval_count` / `eval_count` | 无 | 无 | 缺字段 → `usage_missing` |

## 7. key 控制与配额

### 7.1 上游 key 池 `ai_provider_keys`

| 字段 | 说明 |
| --- | --- |
| `provider_id` | 所属供应商 |
| `label` | 人读的名字（账号 / 额度备注） |
| `secret` | 密钥（**建议加密**，见 Q8） |
| `status` | active / disabled（人工恢复） |
| `weight` / `priority` | 选择权重 |
| `rpm` / `tpm` / `daily_tokens` / `daily_cost_micros` | 该 key 的额度（可空 = 不限） |
| 运行态（Redis） | `cooldown_until`、成功/失败计数、`last_used_at` |

选择算法：

```
候选 = status=active 且 未被冷却 且 额度未用尽
排序 = priority 降序 → 权重随机（weighted RR）→ 最近最少用
选中后原子预占额度（Redis INCRBY + 过期）
上游 429 → 冷却（指数退避，默认 30s 起）
上游 401/403 → 冷却 + 可疑计数；连续 N 次 → status=disabled（人工恢复）
首字节前失败 → 换下一个 key（≤2 次）
```

### 7.2 入站配额

- 现在只有 user / admin 两种身份（无租户表）：先按身份做 RPM / TPM / 并发 / 日预算；粒度待拍板（Q6）。
- Redis 原子计数；超限 429 + `Retry-After`；日预算超限 402。
- 未来对外 API（租户 `billy_sk_...`）：只存哈希、前缀展示、模型范围 + 配额（P4.3c，按需）。

## 8. 安全

| 项 | 措施 |
| --- | --- |
| key 存储 | **建议加密**（`AI_KEY_SECRET`，缺省回落 `jwt.secret`），推翻「明文入库」旧决定；日志/接口只出 hint（复用 `hintOf`） |
| DB 角色 | 3 张配置表只读 + `model_gateway_usage` 只写；不授予 `conversations` / `runs` 读权限 |
| 网络 | 只在内网；`MODEL_GATEWAY_TOKEN` 与 `AGENT_INTERNAL_TOKEN` 分开；不暴露公网 |
| Mastra 边界 | 网关禁止 import `@mastra/*`（`check:mastra` 扩到 `apps/model-gateway/src`） |
| SSRF | 供应商返回 URL 才去下载，且 host 白名单 + 禁内网地址 |
| 日志 | key / 完整 body 脱敏；只记 provider/model/run/token/延迟 |

## 9. 配置与部署

| 项 | 值 |
| --- | --- |
| 端口 | 9992（内网） |
| runtime 侧 | `MODEL_GATEWAY_URL`、`MODEL_GATEWAY_TOKEN`、`MODEL_GATEWAY_TIMEOUT_MS` |
| 网关侧 | `PORT`、`MODEL_GATEWAY_TOKEN`、`DB_URL`（受限角色）、`REDIS_URL`、`MODEL_KEY_SECRET`、`MODEL_GATEWAY_DEFAULT_TIMEOUTS` |
| 探针 | liveness `/healthz`（仅进程）；readiness `/readyz`（PG + Redis + 配置缓存已加载；**不探供应商**） |
| 交付物 | `apps/model-gateway`（Dockerfile + compose service + k8s Deployment/Service）；4 个协议适配器（`src/protocols/*`）；`@repo/contracts` 契约；`@repo/internal-sdk` 的 `ModelGatewayClient` |

## 10. 迁移与回退

| 阶段 | 内容 | 完成标准 |
| --- | --- | --- |
| S0 | **回归用例**：用 mock provider 验证「经网关 canonical 后 DeepSeek `reasoning_content` 仍被 AI SDK 识别、stream 形态不变」 | 通过 → runtime 只留一个 adapter；不通过 → 回退模式保留官方工厂 |
| P4.1 | `apps/model-gateway` 骨架：healthz/readyz、internal token、catalog、配置读取 + 缓存 + `ai.model.changed` 失效；`openai-compatible` + `deepseek` 两个适配器 | 两个 app 可启动，catalog 可查，两家供应商可对话 |
| P4.2 | `/v1/models/{id}/chat/completions` + 归因头 + `model_gateway_usage`；runtime 改指向网关；删除 runtime `modules/ai-model/**` | runtime 无 key、无配置表读取；对话/流式/工具/多模态回归通过 |
| P4.2b | `ollama` 适配器；**列模型同步 / 连通性测试迁到网关**，main 删 `provider-adapters.ts` | main 不再直连供应商；Ollama 可列模型、可对话 |
| P4.3 | `anthropic`（Claude）适配器 + 工具调用/思考/图片/缓存用量映射 | Claude 的对话、工具、思考、图片回归通过 |
| P4.3a | key 池 + 冷却 + 配额（Redis） | 429 自动换 key；额度可见 |
| P4.3b | 模型价格字段 + 请求级成本快照 + 「网关用量/成本」页 + 与 `ai_usage_daily` 对账 | 成本可按 run / 用户 / 模型汇总 |
| P4.4 | 生图：同步接口 + 执行侧落库 + 前端展示（先一家）；异步 job 适配 | 生成图可在会话里看到并下载 |
| P4.5 | 输入文件引用（file ref）/ 视频（按需）/ 对外原生接口（按需） | — |

**回退**：网关无状态，回退就是部署上一版镜像（runtime 的 `ai-model` 已删除，不再有进程内直连开关）。

## 11. 测试计划

| 层 | 用例 |
| --- | --- |
| 契约 | catalog 字段完整；chat 请求/响应可被 AI SDK `openai-compatible` 解析；错误 body 映射 |
| 流 | 正常流；首字节前 429 重试；首字节后断流；慢消费者背压；`[DONE]` 原样；gzip 拒绝；空闲超时；客户端断开 abort 上游 |
| 计量 | usage 尾包解析；缺失 usage；aborted；重试多行；成本按价格版本 |
| key | 多 key 轮换；冷却；连续 401 禁用；额度用尽；并发原子性 |
| 生图 | 同步二进制落库；异步 job 轮询；超时；URL 结果 SSRF 拦截 |
| e2e | runtime 全量 600 测试 + main 接口回归 + 用 mock provider 跑一轮真实流式对话 |

## 12. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| DeepSeek 思考字段经归一丢失 | 前端看不到思考（历史踩过） | S0 spike；不通过则保留官方旁路 |
| 多一跳延迟 | 首 token 变慢 | 同机内网 + keep-alive；实测门限 <100ms |
| 网关单点 | 全站对话不可用 | 无状态多副本；readyz 不探供应商；熔断 10–30s；回退开关 |
| key 泄露 | 供应商账号失守 | 加密 + 最小权限 + 日志脱敏 |
| 成本口径错 | 账单对不上 | 不估算、请求级单价快照、与 `runs.usage` 对账 |
| 供应商差异（超时/限额/字段） | 偶发失败 | 画像表 + 每供应商上限；失败矩阵按供应商配置 |
| 大文件/多模态 | 内存与带宽 | 不解析 body；流式转发；图片上限；视频后置 |

## 13. 待拍板

| # | 问题 | 建议 |
| --- | --- | --- |
| Q1 | 接口形态：canonical 单入口 vs 按 provider 分路径 | **已定（2026-11-15）**：对外 canonical 单入口（路径带 modelId），对内 4 套协议适配器 |
| Q2 | Claude 等异协议：网关做协议转换 vs runtime 保留官方 SDK | **已定（2026-11-15）**：网关实现 4 套协议（含 anthropic），runtime 不再保留官方 SDK |
| Q3 | 输入文件：A inline / B file ref / C 网关上传 | P4.2 用 A，P4.5 再评估 B |
| Q4 | 异步生图：网关内部轮询 vs job 接口 | 网关内部轮询（runtime 简单） |
| Q5 | 生图执行侧：runtime 先跑 vs 直接 worker | 先 runtime，后迁 worker |
| Q6 | 配额粒度：身份 / 全局 / 租户 | 先按身份，预留租户 |
| Q7 | 要不要算钱、价格怎么维护 | **先不算钱（T0）或价格放模型表 + 请求快照（T1）**；独立价格历史表只在需要重算/出账单时再加 |
| Q8 | key 加密：是否推翻明文入库 | **加密**（`AI_KEY_SECRET`） |
| Q9 | 生图入口：agent 工具 vs 产品 API | 工具 + 内部接口，前端按钮复用同一实现 |
| Q10 | 首批范围：同步图 / 异步 / 视频 | 同步图片（≤20MB），异步 P4.4，视频不做 |
| Q11 | 是否对外也暴露 4 套原生协议接口（给外部客户端） | 不对外；只在内部 canonical。真要开放再加 `/native/{protocol}/...` 透传 |
| Q12 | 列模型同步 / 连通性测试何时迁网关 | 建议 P4.2b 与 Ollama 同批（key 只留在网关） |

## 14. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-11-15 | 初稿：定位、归属、canonical 接口、流式转发、文件/产物、计量、key 控制、迁移与回退 |
