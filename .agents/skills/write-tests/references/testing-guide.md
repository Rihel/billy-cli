# 单元测试详解（write-tests 引用文件）

> 本文件是 `write-tests` skill 的组成部分，由主 SKILL.md 引用。
> 写测试时必读。权威参考：`packages/http-client/test/http-client.test.ts`（461 行）与
> `packages/http-client/test/stream-client.test.ts`（SSE 状态机）。

## 1. 工程测试现状与接入

- 框架：**vitest**（根与 `@repo/http-client` 已声明依赖）。
- 现有示例：`packages/http-client/test/`（http-client.test.ts 覆盖策略 / 管理器 / provider /
  请求流程；stream-parser / stream-transport / stream-client 覆盖 SSE 解析与状态机）。
- 测试命令：`packages/http-client/package.json` 已有 `"test": "vitest run"`；
  **新增测试的包需自行在 package.json 加同款 `test` 脚本**。跑单个包：
  `pnpm --filter <包名> test`；全量跑用 `pnpm -r --if-present test`
  （加 `--if-present` 跳过无 test 脚本的包，否则会报错）。
- 文件位置约定：包内 `test/*.test.ts`（沿用 http-client 的做法），或与源码同目录的
  `*.test.ts`；**不要**把测试放进 `dist` / `src/index.ts` 导出链。

## 2. 结构与命名

```ts
import { afterEach, describe, it, expect, vi } from 'vitest'

describe('XxxService', () => {
  it('描述行为（中文，说清楚输入与期望）', async () => {
    // arrange → act → assert
    expect(result).toBe(...)
  })
})
```

- `describe` 按被测单元分组（类 / 模块）；`it` 描述**行为**而非实现细节。
- 断言优先 `expect(x).toBe / toEqual / toMatchObject`。
- **错误断言分两类，勿混淆**：
  - HTTP 层 `ApiError`（`@repo/http-client`）：有 `code` + `status` →
    `await expect(p).rejects.toMatchObject({ code, status })`
  - 业务层 `AppError`（`@repo/kits`，AppErrorCodes 数字码）：只有 `code` →
    `await expect(p).rejects.toMatchObject({ code: 3001 })`
- 异步用例必须 `await`，不要裸 `.catch` 吞错。

## 3. Mock 模式（直接照抄现有写法）

### 3.1 纯类 / 纯函数（最简单）

直接 `new` 被测对象，传构造参数，逐条断言行为：
```ts
const s = new BearerTokenStrategy()
expect(await s.isAuthorization({ token: 'abc' })).toBe(true)
```

### 3.2 全局 fetch mock（HTTP 层）

```ts
function jsonResponse(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => { vi.unstubAllGlobals() })

const fetchFn = vi.fn(async () => jsonResponse({ code: 0, data: { ok: true } }))
vi.stubGlobal('fetch', fetchFn)
```

关键点：`afterEach` 里 `vi.unstubAllGlobals()` 清理，避免用例互相污染。

### 3.3 函数 mock（依赖注入）

```ts
const fn = vi.fn(handler ?? (async () => ({ ok: true })))
// 断言调用次数 / 参数：expect(fn).toHaveBeenCalledTimes(1)
```

### 3.4.1 测 repository（mock Db 门面）

repository 注入 `Db`：mock `db.getRepository(Entity)` 返回假 TypeORM repo
（`findOneBy` / `save` / `remove` / `createQueryBuilder` 各给 `vi.fn()`），
直接 `new XxxRepository(mockDb)`：

```ts
const mockRepo = { findOneBy: vi.fn(async () => null), save: vi.fn(), /* ... */ }
const mockDb = { getRepository: vi.fn(async () => mockRepo) }
const repository = new XxxRepository(mockDb as any)
```

### 3.4.2 测 service（注入 mock repository）

service 注入的是**自定义 repository**（如 `XxxRepository`），直接
`new XxxService(mockRepo)`（`@Inject` 仅影响 DI 容器，直接 new 时传 mock 即可）：

```ts
const mockRepo = { findById: vi.fn(async () => null) }
const service = new XxxService(mockRepo as any)
await expect(service.get({ xxxId: 'nope' })).rejects.toMatchObject({ code: 3001 })
```

- 验证「不存在抛错」：repo 返回 null → 断言 rejects 且 code 等于对应错误码。
- 验证「事务 / 日志」等装饰器行为：不写单测（属框架职责），业务逻辑才是被测对象。
- `as any` 仅在跨层 mock 处使用，业务代码内禁止。

## 4. 测什么 / 不测什么

**测**：纯逻辑与边界——策略判定、凭证生命周期、分页参数换算、错误映射、service 的
「查无 → 抛错」分支、repository 的查询构建（用 mock builder 断言 where/orderBy 调用）。

**不测**（避免脆弱的实现耦合）：装饰器本身（`@Transactional` / `@Injectable`）、
框架行为（zod 校验、hono 路由中间件）、数据库真实读写（用 mock repo，集成靠手测）。
