# 工具命名：key 就是扁平工具名（xxx-xxx）

> **查证优先级：免核**（机制性结论）｜**核对日期**：2026-11-18

## 结论

- **能力 key = 工具名**（`bash`、`file-list`、`memory-save`），扁平 kebab-case，**全局唯一**；
- **服务是工具的分组（1:N）**：登记时声明服务名 + 工具清单，网关建 `key → 服务` 索引；
- 模型面名字与 key 相同（扁平字符集满足 OpenAI / Anthropic 的工具名规则），**不再做 `服务名__工具名` 派生**；
- 跨服务重名在登记时拒绝（409），不加自动后缀；外部团队建议自带业务前缀（如 `order-create`）。

## 为什么改

早先做过 `服务名/工具名` + 模型面 `服务名__工具名`：同一个能力出现两个名字，登记、审计、模型面各一套，加能力要同步多处。2026-11-18 收回到扁平 key。

## 依据

- `docs/design/capability-protocol.md` §3
- `packages/contracts/src/capability.ts`（`isCapabilityKey` / `REMOTE_TOOL_KEYS`）

## 失效信号

- 又出现 `服务名/工具名` 形式的 key → 说明有人把服务当成了 key 前缀，回到 §3.5 的讨论。

## 核对命令

```bash
node --input-type=module -e "import('./packages/contracts/dist/index.mjs').then(m=>console.log(m.REMOTE_TOOL_KEYS.size))"
grep -n "file-list" apps/common-capability/src/capabilities/manifest.ts
```
