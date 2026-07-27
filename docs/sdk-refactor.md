# SDK 架构改造指令

请不要将 ApiClient 改造成 middleware pipeline 架构。目前 SDK 规模和复杂度不需要引入完整 middleware 抽象，避免过度设计。

目标是对现有 ApiClient 做职责拆分，而不是重构成 AWS SDK 风格。

## 1. 保留 ApiClient 作为请求编排入口

ApiClient 的职责：
- 接收请求配置
- 编排认证流程
- 调用 HTTP 请求
- 处理最终请求结果

不要让 ApiClient 内部继续堆积所有细节逻辑。

## 2. 抽离 CredentialResolver（凭证生命周期管理）

职责：负责完整的 credential 生命周期
- 从 CredentialsManager 获取已有凭证
- 判断当前凭证是否可用
- 必要时调用 CredentialProvider.acquire 获取新凭证
- 必要时调用 CredentialProvider.refresh 刷新凭证
- 将新凭证写回 CredentialsManager
- 处理 acquire 并发去重
- 处理 refresh 并发去重

CredentialResolver 不负责：
- HTTP 请求
- header 注入
- auth context 生成

它只解决一个问题："当前请求需要一个可用 credential 时，如何得到它。"

## 3. 抽离 AuthInjector（认证上下文注入）

职责：
- 根据 AuthStrategy 生成认证上下文
- 将认证信息注入请求配置（headers / query / body）

不要让 AuthStrategy 直接修改业务请求数据。避免认证逻辑污染 API payload。

## 4. ApiClient 的 request 流程

```
第一步：skipAuth 检查
  如果跳过 → 直接进入第四步

第二步：CredentialResolver.resolve() → 获取有效 credential

第三步：AuthInjector.inject(config, credentials) → 注入认证上下文

第四步：请求去重（cancel previous, latest wins）

第五步：axios.request()

第六步：错误处理
  401 + 有 refresh → refresh 一次 → 回到第三步
  其他错误 → 抛错
```

## 5. 保留 axios，不抽 Transport

当前阶段不要引入 Transport abstraction。原因：
- SDK 当前主要复杂度在认证生命周期，而不是 HTTP 实现
- axios 已满足当前浏览器/Node 使用场景
- 抽 transport 会增加维护成本

未来如果出现多个 HTTP 实现需求，再考虑抽象。

## 6. 修正认证职责边界

不要让 AuthStrategy 同时承担 credential 生命周期判断。

AuthStrategy 负责：
- 如何使用 credential
- 如何生成 AuthContext
- 如何判断凭证是否满足认证要求

CredentialProvider / CredentialResolver 负责：
- credential 获取
- credential 刷新
- credential 生命周期

## 7. 增加 refresh 并发控制

当前已有 acquirePromise，需要增加 refresh 同类机制。

避免多个请求同时发现 token 过期时：同时 refresh、多次消耗 refresh token、写入互相覆盖。

目标：同一时间只允许一个 refresh 请求，其余请求复用结果。

## 8. 修正 401 retry 逻辑

401 自动 refresh retry 保留，但需要：
- 防止无限 retry
- 单次请求最多 refresh retry 一次
- retry 时重新执行认证注入流程，而不是简单复用旧 headers

## 9. 请求去重逻辑保持，但明确语义

当前 abortMap 实际行为是"取消旧请求，让最新请求继续"，它不是请求合并。

不要命名为 deduplication。应该明确表示：
- cancel previous request
- latest request wins

避免后续维护人员误认为多个相同请求会共享结果。

## 最终组件关系

```
ApiClient：请求编排入口

CredentialResolver：credential 生命周期
  ├─ 依赖 CredentialsManager（存储）
  └─ 依赖 CredentialProvider（获取/刷新）

AuthInjector：认证信息注入
  └─ 依赖 AuthStrategy（认证方式）

CredentialsManager：credential 存储（已有，不变）

CredentialProvider：credential 获取/刷新（已有，不变）

AuthStrategy：认证方式（已有，职责收紧）

Axios：HTTP 请求执行（已有，不变）
```

不要引入 middleware pipeline，保持轻量 SDK 架构。
