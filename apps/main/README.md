# @app/main

公网 BFF / 控制面服务（端口 9989）。前端只连这里。

职责：

- auth / user / admin / session
- storage / share / monitor / ops / runtime-config / stream
- AI 控制面 CRUD：
  - `/ai-model/*`
  - `/ai-tool/*`
  - `/ai-skill/*`
  - `/ai-connector/*`
  - `/ai-memory/*`
- 会话 / run / timeline / usage 查询
- `POST /agent/chat/stream`：生成 clientId，调 agent-runtime 内部接口，消费 Kafka
  `agent.run.events` 并推 SSE 给前端

不跑 agent loop，不加载 Mastra，不执行工具。

启动：

```bash
pnpm --filter @app/main dev
```
