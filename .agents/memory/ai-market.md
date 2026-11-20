# AI 市场（P12）

**查证优先级：必核**（改市场表 / 收录接口前复核）

## 结论（2026-11-20，v1 MCP 区）

- 表：`ai_market_items`（`key` 软删唯一 + `(type, scope)` 索引）；实体 `AiMarketItemEntity`。
- 口径：MCP = 平台资产、管理员收录（`scope` 固定 `platform`）；CLI / 技能 = 个人资产，随用户端开放。
  **市场不是白名单**：未收录的 CLI 仍可在初始化清单里声明。
- v1 边界：入参 schema 只接受 `type='mcp'`（其它类型在 schema 层拒绝），市场只准备声明，
  不装二进制、不启容器。
- 接口：`/ai-market/{list,save,remove}`（管理员鉴权，SDK `aiMarket.*`，页面 `/main/ai/market`）；`save` 按 key 幂等 upsert；
  删除缺条目 → `3501 MarketItemNotFound`。

## 依据

- `docs/design/workspace-cli-credentials.md` §6.9
- `packages/db/src/entities/ai-market-item-entity.ts`、`apps/main/src/modules/ai-market/**`
- 核对：`pnpm --filter @app/main exec vitest run test/market-service.test.ts`

## 失效信号

开放 CLI / 技能区（schema 与 scope 规则要改）/ 市场变成准入白名单 / 收录改成走能力网关登记。
