# model-gateway（内部模型网关）

> **查证优先级：抽核** —— 记录 2026-11-15 首个切片的落点与开关；改协议 / 改路由 / 加供应商协议后重核。

## 结论

| 事项 | 位置 / 约定 |
| --- | --- |
| 服务 | `apps/model-gateway`（`@app/model-gateway`，9992，只在内网） |
| canonical 对话 | `POST /v1/models/{modelId}/chat/completions`（**路径带 modelId**，网关不解析 body 路由） |
| 目录 | `GET /internal/catalog`（无 key / 无上游地址；runtime 缓存 30s） |
| 鉴权 | `x-internal-token: MODEL_INTERNAL_TOKEN`（runtime 用 `createOpenAICompatible` 的 `headers` 注入） |
| 协议 | `openai-compatible` / `deepseek` / `ollama` / `anthropic` 四个均已实现 |
| 适配器 | `apps/model-gateway/src/protocols/*`，按 `kind → protocol`（`packages/shared/src/dicts/ai-provider-endpoint.dict.ts`）选 |
| runtime | **唯一模型来源**：`ModelGatewayCatalogService`（目录缓存 30s，实现 `RuntimeModelResolver` 端口）；runtime 的 `modules/ai-model/**` 已删除，不读配置表、不持 key |
| 模型实例 | `apps/agent-runtime/src/modules/ai/mastra/agent.adapter.ts` 的 `model.gateway` 分支（`@ai-sdk/openai-compatible` + `includeUsage`） |
| 计量 | `model_gateway_usage`（价格快照 + cost_micros + 归因头）；key 池 `ai_provider_keys` + Redis 冷却/额度 |
| 同步/测试 | 已迁网关：`POST /internal/providers/{list-models,test}`；main 只 upsert / 返回结果 |
| 供应商画像 | `PROVIDER_ENDPOINTS` 已从两个 app 的 provider-adapters 收到 `@repo/shared`（含 chatPath / authStyle） |

**Ollama 本地验证**（无需密钥；列模型走 `/api/tags`，probe 对无鉴权协议允许空 key）：
1. DB 里插 `ai_providers(kind='ollama', base_url='http://127.0.0.1:11434')` + `ai_models(model_key='qwen3.8:27b')`；
2. 起 `pnpm dev:model-gateway`；
3. `curl -H 'x-internal-token: dev-model-token' localhost:9992/internal/catalog`；
4. `curl -N -X POST .../v1/models/{id}/chat/completions -H 'x-internal-token: ...' -d '{"messages":[...],"stream":true}'`
   → 网关把 Ollama 的 NDJSON 翻成 OpenAI SSE（`reasoning_content` 来自 `message.thinking`）。

## 坑：DeepSeek 思考模式 + 工具续跑必须回放 `reasoning_content`

- **触发条件**：请求**带 `tools`** 时，历史里每条 assistant 都必须有 `reasoning_content`，
  缺了上游必回 400（`The reasoning_content in the thinking mode must be passed back to the API`）；
  该轮没实际调工具也算，以 tool 结果收尾的续跑最容易中。**不带 `tools` 时上游忽略该字段、不报错**。
- **判据不是**「传没传 thinking / reasoning_effort、模型名是否含 reasoner」：runtime 经网关调用**都不发**这两个参数，
  模型名又是 `deepseek-flash` → 旧判据全不中、整段跳过。2026-11-15 实测（直打网关，最小请求体）。
- **修法**：`apps/model-gateway/src/protocols/deepseek.adapter.ts` 的 `withDeepSeekReasoning`——
  带 tools 就给 assistant 补 `""`（上游接受空串；`thinking:{type:disabled}` 时补空串同样 200）。
- **核对**：`pnpm --filter @app/model-gateway test`；线上复现看 `timelines` 的 `system/error` 行 + `model_gateway_usage` 的 400 流水。

## 坑：Ollama 的 assistant `tool_calls[].function.arguments` 必须对象

- OpenAI 形态给的是 JSON **字符串**；Ollama 的 Go 结构体要对象，原样透传直接 400
  `Value looks like object, but can't find closing '}' symbol`（2026-11-15 实测：字符串 400 / 对象 200）。
- 现象与 DeepSeek 那条同类：**「调工具 → 拿结果 → 再问」的第二轮必挂**；请求侧转换在
  `ollama.adapter.ts` 的 `toOllamaToolCalls`（`id` / `type` / `index` 一并收掉）。
- 核对：`pnpm --filter @app/model-gateway test`；本地起 9992 后用带 tool_calls 历史的请求重放。

## 未做（别再误以为已有）

- key 加密（`ai_providers.api_key` / `ai_provider_keys.secret` 仍明文；本轮明确不做）；
- 生图（P4.4：images/jobs/产物落 OSS + ai_files）。

已补：`model_gateway_usage` 读取 API（main `/agent/usage/gateway/*`）、用量/成本/对账 admin 页、
key 池与模型价格 admin 页、provider key SDK、k8s 清单（含 HPA/PVC）、AI 对话按用户限流。

## 失效信号

协议适配器 / 路由 / `kind→protocol` 表任一改动，先看 `docs/design/model-gateway.md` 与
`git log --oneline -5 -- apps/model-gateway`。
