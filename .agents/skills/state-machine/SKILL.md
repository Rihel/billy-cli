---
name: state-machine
description: 在 Billy 工程中实现业务状态机：状态字典 + 转移表纯函数（轻量方案）或 xstate 门面（复杂方案），状态字段落实体、并发安全（乐观锁 / 分布式锁）。触发词：状态机、状态流转、状态转移、订单状态、审批流、transition、转移表、状态图。
---

# 状态机

前置：先加载必读 skill `billy-dev-foundation`（「不重复造轮子」实现查找顺序见其
`references/code-conventions.md` 第 10 条——**优先用轻量方案，不轻易引状态机库**）。
涉及状态字典 / 字段时加载 `define-dict-enum`、`define-data-structure`；并发安全加载 `concurrency`。

## 核心要点

- 状态机 = 状态 + 事件 + 转移表，把流转规则集中显式，杜绝散落 if/else。
- **轻量方案（优先）**：状态字典（`shared/dicts`）+ 转移表纯函数（`shared/utils`），
  纯函数可单测；非法转移抛错由 service 捕获。
- **数据**：状态存实体 string 列（字典 value），schema 用 `z.enum` 校验。
- **并发安全**：状态变更不可裸奔「读-改-写」，用乐观锁（version 列）或分布式锁。
- **复杂方案**：仅当需要守卫 / 副作用 / 上下文时才引 xstate，门面放 `core/foundation`。

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/state-machine-guide.md](./references/state-machine-guide.md) | 轻量转移表代码、数据落点、service 用法、并发安全、复杂方案、归位表 | 做状态流转时（必读） |

## 完成检查清单

- [ ] 优先用「字典 + 转移表纯函数」，未为简单场景引状态机库
- [ ] 转移规则集中、显式，非法转移有明确报错（业务错误 + 错误码）
- [ ] 状态存实体 string 列（字典 value），schema 已校验
- [ ] 状态变更已做并发安全（乐观锁或分布式锁），非裸「读-改-写」
- [ ] 转移表为纯函数，已有单测覆盖合法 / 非法转移
