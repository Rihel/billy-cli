# 状态机详解（state-machine 引用文件）

> 本文件是 `state-machine` skill 的组成部分，由主 SKILL.md 引用。
> 实现业务状态流转（订单 / 审批 / 任务等）时必读。

## 1. 状态机的本质

状态机 = **状态 + 事件 + 转移表**：在给定当前状态下收到事件，按转移表决定下一个状态
（可带守卫校验、副作用）。核心价值是**把状态流转规则集中、显式**，杜绝到处 if/else。

## 2. 轻量方案（优先，推荐）

工程现状足够时用「字典 + 转移表纯函数」，不引状态机库：

### 2.1 状态字典（shared/dicts）

```ts
// packages/shared/src/dicts/order-status.dict.ts
export const OrderStatus = createDict({
  Created:  { label: '已创建', value: 'created' },
  Paid:     { label: '已支付', value: 'paid' },
  Shipped:  { label: '已发货', value: 'shipped' },
  Completed:{ label: '已完成', value: 'completed' },
  Cancelled:{ label: '已取消', value: 'cancelled' },
})
```

### 2.2 转移表 + 纯函数（shared/utils）

```ts
// packages/shared/src/utils/order-state.utils.ts —— 纯函数、无 IO、可单测
export const OrderTransitions = {
  created:  { pay: 'paid', cancel: 'cancelled' },
  paid:     { ship: 'shipped', cancel: 'cancelled' },
  shipped:  { complete: 'completed' },
  completed:{},   // 终态
  cancelled:{},   // 终态
} as const

export function transition(current: string, event: string): string {
  const next = OrderTransitions[current]?.[event]
  if (!next) throw new OrderStateError(`非法转移: ${current} × ${event}`)
  return next
}
```

- 转移表是**纯数据**，转移函数是**纯函数** → 放 `shared/utils`，天然可单测。
- 非法转移**抛错**（业务错误，带错误码），由 service 层捕获转成用户可读错误。

## 3. 数据与 schema 落点

- **状态存实体 string 列**（字典 value，不用 PG enum），默认值引用字典（见 `define-dict-enum` / `define-data-structure`）：
  ```ts
  @Column({ name: 'status', default: OrderStatus.Created, length: 20, comment: '订单状态' })
  status: string
  ```
- schema 值域校验：`z.enum(OrderStatus.values as [string, ...string[]])` 或硬编码。

## 4. 业务层用法（service）

```ts
@Transactional()
async updateStatus(input: { orderId: string; event: string }): Promise<OrderModel> {
  const order = await this.repo.findById(input.orderId)
  if (!order) throw new OrderNotFoundError(input.orderId)
  const next = transition(order.status, input.event)   // 非法转移在此抛错
  return this.repo.update(input.orderId, { status: next })
}
```

## 5. 并发安全（关键）

状态变更**不可靠「读-改-写」裸奔**，多实例 / 并发下会互相覆盖：
- **乐观锁（推荐）**：实体加 `version` 列，`update ... where id=? and version=?`，失败重试或报冲突。
- 或分布式锁（`concurrency` skill 的 `RedisStore.acquireLock`）：`order:status:<id>` 锁住状态转移。

## 6. 复杂方案：引入状态机库（xstate 等）

仅当需要**守卫（guard）、副作用（action）、上下文（context）、嵌套状态图**等重特性时，
才引入（先按「实现查找顺序」确认无更轻方案）：
- 门面放 `core/foundation`（横切基础能力）或独立模块，业务模块只依赖门面，不散落 import 库。

## 7. 归位汇总

| 内容 | 落点 |
| --- | --- |
| 状态字典 | `shared/dicts/<domain>-status.dict.ts` |
| 转移表 + 转移函数（纯） | `shared/utils/<domain>-state.utils.ts` |
| 状态字段 | 实体 string 列（`db/entities`） |
| 状态校验 | schema `z.enum` |
| 状态机库门面（如引 xstate） | `core/foundation` |
| 业务编排 / 持久化 | `core/modules/<domain>/*.service.ts` |
