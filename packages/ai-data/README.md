# @repo/ai-data

跨 app 共用的**数据层**：repository + service + 领域规则，只依赖 `@repo/db` / `@repo/kits` / `@repo/shared`。

- server 与 tool-worker 共用同一份实现；worker 用受限 DB 账号直连，不回调 server。
- 当前已收：memory、file（repository/service/workspace）、分页纯函数。
- skill 管理依赖 Mastra 校验，留在 server 控制面（worker 不注册）。
