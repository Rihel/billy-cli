---
name: write-tests
description: 在 Billy 工程中编写单元测试（vitest）：测试文件位置与命名、describe/it/expect/vi 结构、依赖与 fetch mock 模式、错误断言（ApiError 有 status / AppError 只有 code）、业务 service / repository 测试套路、测试脚本接入。触发词：写测试、单元测试、单测、测试用例、vitest、mock。
---

# 编写单元测试

前置：先加载必读 skill `billy-dev-foundation`（「不重复造轮子」实现查找顺序：测试
框架与断言库用 vitest，不自己造 mock 工具）。

## 核心要点

- 框架 **vitest**；权威参考 `packages/http-client/test/http-client.test.ts` 与
  `packages/http-client/test/stream-client.test.ts`（覆盖策略 / 管理器 / SSE 状态机）。
- 错误断言分两类：HTTP 层 `ApiError` 用 `{ code, status }`；业务层 `AppError` 只用 `{ code }`。
- mock 用 vitest 原生（`vi.fn` / `vi.stubGlobal`），`afterEach` 里 `vi.unstubAllGlobals()` 清理。
- 新增测试的包要自加 `"test": "vitest run"` 脚本；跑单包 `pnpm --filter <包> test`。

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/testing-guide.md](./references/testing-guide.md) | 结构与命名、fetch mock、repository / service 测试套路、测什么 / 不测什么 | 写 / 修测试时（必读） |

## 完成检查清单

- [ ] 测试文件位于 `test/*.test.ts`（或源码旁 `*.test.ts`），未被 index 导出
- [ ] 所属包 package.json 已有 `test: vitest run` 脚本（没有则补上）
- [ ] mock 用 vi（stubGlobal / fn），`afterEach` 清理全局 stub
- [ ] 错误路径有断言：ApiError 用 `{ code, status }`、AppError 用 `{ code }`，覆盖「查无 / 无权限」等
- [ ] 未重复造轮子：断言 / mock 均用 vitest 原生能力，未自写框架
- [ ] `pnpm --filter <包> test` 通过
