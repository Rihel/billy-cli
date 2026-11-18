# HTTP 传输分层（http-client）

- **查证**：抽核（包结构调整后重新看）
- **依据**：`packages/http-client/src/core/http.client.ts`、`src/transport/http-transport.ts`、`src/stream/stream-client.ts`；`packages/internal-sdk/src/http.ts`

三层职责：

| 层 | 用途 | 关键约束 |
| --- | --- | --- |
| `HttpTransport` | 原始请求 / 流式字节 / NDJSON / SSE | 无凭证；非 2xx 不抛；`streamRaw` 一次性、永不重连 |
| `HttpClient` | 业务 API 客户端 | 凭证 / 401 刷新 / `AppResponse` 解包 / cancelPrevious |
| `HttpStreamClient` | 前端 SSE 订阅 | 自动重连、Last-Event-ID、页面隐藏暂停 |

内部 JSON 契约（2026-11-15 起）：

- `/internal/**` 与 capability-gateway / common-capability 业务路由：`{ code, data }` 信封；
- `/v1/**`（模型协议）、`/healthz` `/readyz`、流式：**裸 JSON / SSE / NDJSON**，不能包；
- `internal-sdk` 业务调用用 `requestEnvelope`，探针用 `requestJson`。

网关供应商调用走 `HttpTransport`（probe 用 `requestRaw`，chat 用 `streamRaw`）；
Ollama 的 NDJSON 翻译仍在网关协议适配器，不在 http-client。

失效信号：内部新增业务路由若忘了 `ResponseEnvelopeInterceptor`，`requestEnvelope` 会直接协议错误。
