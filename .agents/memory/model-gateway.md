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

**Ollama 本地验证**（无需密钥）：
1. DB 里插 `ai_providers(kind='ollama', base_url='http://127.0.0.1:11434')` + `ai_models(model_key='qwen3.8:27b')`；
2. 起 `pnpm dev:model-gateway`；
3. `curl -H 'x-internal-token: dev-model-token' localhost:9992/internal/catalog`；
4. `curl -N -X POST .../v1/models/{id}/chat/completions -H 'x-internal-token: ...' -d '{"messages":[...],"stream":true}'`
   → 网关把 Ollama 的 NDJSON 翻成 OpenAI SSE（`reasoning_content` 来自 `message.thinking`）。

## 未做（别再误以为已有）

- `model_gateway_usage` 流水 / 成本 / key 池 / 配额（P4.3）；
- `anthropic` 适配器（P4.3）；
- main 的「同步 / 连通性测试」仍在 main 直连供应商（P4.2b 迁网关）；
- k8s 清单（目前只有 Dockerfile + compose）；
- admin 页面的 key / 价格输入 / 用量成本 UI（key CRUD 与价格字段 API 已有）；
- key 加密（仍明文入库）；
- 生图（P4.4）与 k8s 清单。

## 失效信号

协议适配器 / 路由 / `kind→protocol` 表任一改动，先看 `docs/design/model-gateway.md` 与
`git log --oneline -5 -- apps/model-gateway`。
