# @app/model-gateway（内部模型网关，9992）

只在内网；由 `agent-runtime` 调用。它把「供应商协议差异」收在一处，runtime 只认一套
canonical OpenAI 接口。

## 职责

- **目录**：`GET /internal/catalog` —— 启用的对话模型（含 `protocol` / `contextWindow` / 模态），**不含 key**；
- **对话**：`POST /v1/models/{modelId}/chat/completions` —— 请求/响应 OpenAI 形态；
  网关按 `ai_providers.kind → protocol` 选适配器，注入真实 key；
- **协议**（4 套）：`openai-compatible`（字节透传）、`deepseek`（补 `reasoning_content` 回放）、
  `ollama`（NDJSON → SSE）、`anthropic`（P4.3，当前留桩）；
- 只读 `ai_providers` / `ai_models`；不写 `ai_files` / `runs` / `timelines`，不 import `@mastra/*`。

## 本地运行

```bash
pnpm dev:model-gateway          # 9992
curl -H 'x-internal-token: dev-model-token' localhost:9992/internal/catalog
```

Ollama 联调：DB 里配一条 `kind='ollama'` 的供应商（`base_url=http://127.0.0.1:11434`）和
`model_key` 为本地模型名的模型，然后：

```bash
curl -N -X POST localhost:9992/v1/models/<modelId>/chat/completions \
  -H 'x-internal-token: dev-model-token' -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"你好"}],"stream":true}'
```

## 配置

见 `.env.example`：`MODEL_GATEWAY_PORT` / `MODEL_INTERNAL_TOKEN` / `DB_URL` /
`MODEL_GATEWAY_CACHE_TTL_MS` / `MODEL_GATEWAY_FIRST_BYTE_TIMEOUT_MS` / `MODEL_GATEWAY_IDLE_TIMEOUT_MS`。

## 尚未实现（按设计稿 P4.3）

用量流水 / 成本、key 池与配额、anthropic 适配器、main 的同步/测试迁入、k8s 清单。
