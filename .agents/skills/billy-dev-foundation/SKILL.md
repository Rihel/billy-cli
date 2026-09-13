---
name: billy-dev-foundation
description: Billy 工程（billy-cli monorepo）开发必读 skill。任何在本仓库进行开发、重构、修 bug、加接口或功能之前，必须先加载本 skill，了解分层架构、目录约定、命名规则、常用命令与标准开发流程。触发词：billy、开发规范、分层、架构、monorepo、加功能、改接口、重构、代码约定、CRUD、全栈、NestJS。
---

# Billy 开发基础规范与流程（必读）

> **工程首要准则**：实事求是、没有调查、抓主要矛盾、具体分析、集中兵力、实践检验、
> 独立自主、战略藐视战术重视 —— [references/principles.md](./references/principles.md)。

这是本工程唯一的「必读」skill。开始任何编码任务前，先阅读本文件及其引用的
`references/` 文件，再按下文「Skill 目录」按需加载功能 skill。

## Skill 目录（工程 skill 一览）

完整目录（15 个功能 + 1 个元 skill，含用途与加载时机）见
[references/catalog.md](./references/catalog.md)；以 `.agents/skills/README.md` 为同步索引。

## 分层铁律

依赖方向不可逆：`shared` 不依赖业务包；`kits` 不 import `apps/*`；`apps/server` 是业务
与组合根的归属，`root.module.ts` 是唯一组合根（`common/` 放横切 HTTP 构件且不依赖具体业务
模块，controller 只做 HTTP 边界）；kits 侧是「**一个基础设施一个 `@Global()` 模块，`XxxModule.forRoot(options)` /
`forRootAsync(options)` 自带配置 bean**」（配置即模块自身注入 bean，未 import 即未装配），按依赖方向
自底向上落代码（架构见 [references/architecture.md](./references/architecture.md)）。
**应用配置**由 `AppConfigFacade.initial({ schema, loader })` 在 bootstrap 前统一加载校验
（`schema` 是应用自定义 shape，`loader` 决定来源：内置 env / memory / consul，或自定义 loader），经
`AppConfigModule.forRoot()` 接进 Nest 的全局 `ConfigService`，各模块用 `forRootAsync` 惰性取分片。

## 第 6 条铁律：构造器必须显式 `@Inject`

项目开发用 `tsx`（esbuild），**不产出 `design:paramtypes`**。因此 NestJS 的**每一个构造器
参数都必须显式写 `@Inject(token)`**，不能依赖 TypeScript 类型推断 —— 漏写会**静默注入
`undefined`，不报错**。controller / service / repository / guard / filter 的构造器一律
`@Inject(Xxx)`（kits 内部对带可选数值参数的构造器用 `useFactory` 显式装配）。

## 第 7 条铁律：配置必须「惰性取」

应用配置链路（对齐 rihel-base）：

1. `apps/server/src/app-config.ts` 定义 `serverAppConfigSchema`（**复用 kits 各模块的 config schema** 组合成
   命名空间：`server` / `monitor` / `db` / `redis` / `jwt` / `password` / `storage` / `logger` / `notify` /
   `lark?` / `kafka?`）+ `mapServerEnv` 定义「环境变量 → 嵌套配置」；
2. `main.ts` 与 `apps/server/scripts/seed-admin.ts` 的**首行** `await loadServerAppConfig()` 完成加载 + 校验 + 补默认值
   （`AppConfigFacade` 缓存，幂等）；其内部只声明来源：
   `AppConfigFacade.initial({ schema: serverAppConfigSchema, loader: envConfigLoader({ envFileName: '.env', mapEnv: mapServerEnv }) })`
   —— `schema` 是应用 shape、`loader` 决定来源（内置 env / memory / consul，或自定义实例 /
   `registerConfigLoader` 注册的名字），换来源只改 `loader` 一行；
3. `AppConfigModule.forRoot()` 把它接进 Nest（全局 `ConfigService` + `AppConfig` bean）；
4. 各基础设施用 `forRootAsync({ imports: [ConfigModule], inject: [ConfigService], useFactory: (config) =>
   config.get('<命名空间>') })` **惰性**取自己的分片。

**为什么必须惰性**：ESM 下 `import { RootModule }` 的装饰器求值**早于** `main()` 里的配置加载，
所以在 `root.module.ts` 顶层直接读配置值会拿到空值。**规则**：新增需要配置的能力，一律在
`forRootAsync` 的 `useFactory` 里取，不要在模块装饰器参数里直接取值。

**例外**：`LARK_APP_ID` / `KAFKA_BROKERS` 只用于判断「可选模块是否装配」（模块集合在 bootstrap 期
静态确定），这类开关仍读 `process.env`；开关背后的配置值同样经应用配置校验。

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/architecture.md](./references/architecture.md) | 工程定位、技术栈、分层架构详解、数据流 | 每次任务开始（必读） |
| [references/placement.md](./references/placement.md) | 能力归位决策：新能力该放哪个包 / 目录 / 文件，各落点的模式要求 | 遇到无基础能力的新需求（状态机 / 队列 / 心跳 / 限流等）时（必读） |
| [references/design.md](./references/design.md) | 设计决策：评估难度决定是否出方案、方案原则、借鉴成熟方案 | 中等 / 复杂需求动手前（必读） |
| [references/code-conventions.md](./references/code-conventions.md) | 硬性代码约定 11 条，含「不重复造轮子」查找顺序 | 写任何代码前（必读） |
| [references/commands.md](./references/commands.md) | 常用命令 | 需要执行命令时 |
| [references/workflow.md](./references/workflow.md) | 标准开发流程、参考实现（todo 全链路） | 任务执行过程中 |

## 完成检查清单

- [ ] schema / dict / entity 三者字段一致，且都已在对应 `index.ts` 导出
- [ ] 新实体已放入 `apps/server/src/database/entities/`，并在 `apps/server/src/root.module.ts` 的
  `DbModule.forRootAsync` 工厂里补进 `entities: [...]`，且已生成 + 执行迁移
- [ ] 新业务模块已在 `apps/server/src/root.module.ts` 的 `imports` 注册，模块内
  `controllers` / `providers` 已声明，并在 `apps/server/src/modules/<业务>/index.ts` 导出
- [ ] **每个构造器参数都显式写了 `@Inject(token)`**（tsx 不产出 `design:paramtypes`，漏写静默注入 undefined）
- [ ] controller 只做 HTTP 边界（`@Body({ schema: Schema })` 校验 + 调 service + 返回数据），业务逻辑在 service / repository
- [ ] 所有业务路由为 `POST` 且显式标注 `@HttpCode(200)`（Nest 对 POST 默认 201）
- [ ] 错误全部继承 `AppError` 且 code 已在 `AppErrorCodes` 中定义（3xxx 段）
- [ ] SDK 已补全类型化方法
- [ ] admin 页面已加入 `apps/admin/src/components/AppMenu.tsx` 菜单
- [ ] 相对导入后缀与所在包既有风格一致；纯类型用 `import type`
- [ ] 改动触及 skill 提到的包 / 组件 / 命令时，已按 `manage-skills` 的「代码变更后的 skill 同步」更新相关 skill
- [ ] 未重复造轮子：已按「实现查找顺序」确认无现成实现
- [ ] 已把本次开发记录追加到 `docs/dev-logs/yyyy-MM-dd.md`（单次 ≤500 字符）
- [ ] 输出文案 / 程序日志 / 注释 / 文档均为简体中文
- [ ] `pnpm dev:pkgs` 与目标 app 类型检查通过
