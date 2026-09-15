# 硬性代码约定（billy-dev-foundation 引用文件）

> 本文件是 `billy-dev-foundation` skill 的组成部分，由主 SKILL.md 引用。
> **写任何代码前先阅读并遵守以下约定。**

1. **包内相对导入后缀**：`@repo/kits`、`apps/server` 内相对导入带 `.js` 后缀
   （如 `'./errors.js'`、`'../../common/http/zod-validation.js'`）；`@repo/shared` 及前端 app 不带后缀。
   **新代码跟随所在包的既有风格，不混用**。跨包一律 `@repo/*`（如 `@repo/kits`、
   `@repo/shared`、`@repo/shared/logger` 子路径，后者是**前后端共用**的日志工厂）。
2. **错误体系**：业务 / 基础设施错误必须继承 `AppError`
   （`packages/kits/src/foundation/errors/app-error.ts`），提供只读 `code`
   （来自 `AppErrorCodes`）。边界自动映射 HTTP + 中文，禁止在 server 层手写错误文案。
3. **错误码分段**（`packages/shared/src/dicts/app-error-code.dict.ts`）：
   `1xxx` 认证、`2xxx` 用户 / 管理员、`3xxx` 业务模块（新模块从这里起段）、
   `4xxx` 输入校验、`5xxx` 系统。
4. **统一响应格式**：成功 `{ code: 0, data }`；分页 `{ items, total, page, size }`；
   游标 `{ items, nextCursor }`（见 `@repo/shared` 的 `AppResponse` / `AppPageQueryResponse` /
   `AppCursorQueryResponse`）。所有业务接口统一 `POST + JSON body`，不用 REST 动词。
5. **DI**：业务类用 `@Injectable()`，构造器参数用 `@Inject(Token)`，可选依赖用 `@Optional()`
   （均来自 `@nestjs/common`）。**项目用 tsx（esbuild）不产出 `design:paramtypes`，每个构造器
   参数都必须显式 `@Inject(token)`**，不能依赖 TypeScript 类型推断（漏写会静默注入 `undefined`，
   不报错）；controller / service / repository / guard / filter 一律 `@Inject(Xxx)`。
   **开发态加载器必须是 `node --import tsx/esm`（`pnpm dev:server` 已内置），不要用 `tsx` CLI**：
   `tsx` CLI 同时挂 CJS 钩子，CJS 依赖（如 `pino`、`pg`、`@nestjs/platform-express`）的
   `require('@nestjs/core')` 与 ESM `import` 会拿到两份模块实例，`ApplicationConfig` 这类跨包
   class token 对不上 → 启动即 `Nest can't resolve dependencies of the XxxModule (?, ?)`；
   一次性脚本还要注意 `pino-pretty` 的 transport worker 不随 `app.close()` 结束
   （脚本末尾显式 `process.exit`）。
   日志用**构造器注入** `@Inject(AppLogger)`（`AppLogger` 来自 `@repo/kits`，`Scope.TRANSIENT` +
   `INQUIRER` 自动以宿主类名作 `context`；`@Logger()` 装饰器已删除，不要再写）；写操作加
   `@Transactional()`（来自 `@repo/kits` 的 re-export）；
   **新增业务 service / repository 无需在 `main.ts` 注册** —— 在 `<业务>.module.ts` 的 `providers`
   声明，再把该模块加入 `apps/server/src/root.module.ts` 的 `imports`；实体在
   `root.module.ts` 的 `DbModule.forRootAsync` 工厂里补 `entities`。kits 基建的装配在各基础设施模块
   自己的 `forRoot` / `forRootAsync` 内完成（配置对象即该模块的注入 bean，业务层勿动）；
   **配置一律惰性取**：`forRootAsync` + `ConfigService.get('<命名空间>')`，不在 `root.module.ts`
   顶层直读配置值（ESM 装饰器求值早于 bootstrap 期的配置加载）。**应用级业务配置**（端口 / 鉴权开关 /
   限流白名单等 `server` 分片）同理：注入全局 `ConfigService` 后调 `apps/server/src/config.ts` 的
   `resolveServerConfig(config)`，**不要再为它加配置 bean / module**。应用配置 shape 定义在
   `apps/server/src/app-config.ts`，来源由 `AppConfigFacade.initial({ schema, loader })` 的 `loader` 决定
   （`kits/foundation/config/`：可插拔 `ConfigLoader` + 内置 env / memory / consul，自定义来源实现
   `ConfigLoader` 或用 `registerConfigLoader` 注册成按名字引用）。
   生命周期钩子用 NestJS 的 `OnApplicationBootstrap` / `OnApplicationShutdown`
   （方法名 `onApplicationBootstrap` / `onApplicationShutdown`）。
   **DI 装饰器是二元的（务必统一）**：
   - **由容器装配的类**（标 `@Injectable()` / `@Controller()` / `@Catch()`，或裸类名出现在
     `providers:` 里）→ **每个构造器参数都必须 `@Inject(token)`**，`providers` 里的裸类名必须标
     `@Injectable()`。原因：开发态用 tsx（esbuild）**不产出 `design:paramtypes`**，Nest 拿不到
     参数类型，漏写会**静默注入 `undefined`**（不报错，运行时才炸）。
   - **不经容器装配的类**（手工 `new`、`useFactory: () => new X()`、由第三方实例化如 TypeORM
     subscriber）→ **刻意不写** `@Injectable()` / `@Inject()`：写了是死代码且误导。
     实例：`RedisListCache`（多实例手工 new）、`Telemetry`（`useFactory` 装配，
     构造参数是数值 `windowSeconds` 而非注入 token）、`TimeWheel`。
   - **守卫**：`pnpm check:inject`（同时被 `apps/server/test/di-inject-convention.test.ts` 覆盖），
     校验上述两条不变量，违反即红灯；**不要靠人眼保证**。
   - 为什么不学 rihel-base 那样省掉 `@Inject`：rihel 用 `nest start` / `nest build`（底层 tsc），
     会产出 `design:paramtypes`，所以它应用层 0 处 `@Inject`；billy 开发态走 esbuild，元数据缺席，
     显式 token 是唯一来源（且让 dev / prod 走同一条注入路径）。这是加载器差异，不是风格差异。
6. **实体**（`apps/server/src/database/entities/`）：继承 `BaseEntity`（来自 `@repo/kits`，
   自动 id = nanoid(20)、
   created_at / updated_at / deleted_at 均为 timestamp(3)）；表名复数；列名 snake_case、
   字段名 camelCase；索引 / 唯一约束显式命名（`idx_*` / `uk_*`）。软删除 + 唯一约束
   必须把 `deletedAt` 纳入唯一键（如 `@Unique('uk_user_email', ['email', 'deletedAt'])`）。
7. **命名**：文件 `kebab-case`；共享契约常量统一 `XxxSchema`（**值**后缀），入参类型 `XxxDto`、
   响应类型 `XxxModel`（**类型**后缀，`z.infer` 结果），类型与 schema 导出在**同一文件**；
   实体 `XxxEntity`；类名 PascalCase。禁止 schema 常量用 `Dto` / `Model` 后缀（同名值 + 类型会
   发生声明合并）；细则见 `define-data-structure` 3.1。
8. **前端**：admin 页面一律 `'use client'` + `@repo/ui`（DataTable / DataList /
   ModalForm / DrawerForm / ConfirmAction / PageToolbar / 存储组件等）+ TanStack
   Query（useQuery / useMutation）+ `@tanstack/react-table`（DataTable 列定义）+
   `@tanstack/react-form`（`useForm` 创建表单实例，ModalForm / DrawerForm 声明式 items）+
   `useServerClient()`；web 同用 `@repo/ui`（Base UI + shadcn + Tailwind 4）。
   前端组件统一来自 `@repo/ui`（shadcn/ui 风格）。**组件目录约定**：`ui/src/components/ui/*`
   由 shadcn 维护（用 shadcn CLI 更新，保留其文件，需要时可直接改其内容）；自有封装一律放
   `ui/src/components/*`（如 data-table / modal-form / markdown），禁止放进 `components/ui/*`。
   **样式约定**：改组件 / 页面视觉优先用组件 className（在业务组件或页面传入，如 AppMenu /
   DataTable）；不要用 CSS 覆盖 shadcn 默认类（`@layer base` 内的覆盖会被 utilities 层压过），
   必须写 CSS 时放在 `@layer` 之外（非 layer 优先于所有 layer）。
9. **纯类型导入用 `import type`**：`apps/server` 开启 `verbatimModuleSyntax`，值 / 类型
   混用导入会报错；其余 packages 虽未开启，仍统一用 `import type` 区分纯类型，保持风格一致。
10. **不要重复造轮子（实现查找顺序，最高优先）**：任何功能实现之前，先按以下顺序
    查找现成实现，**全部都没有才允许自己写**：
    1. **各个包有无实现**：`packages/*`（shared / kits / sdk / http-client / ui）里是否已有类似能力（工具函数、schema、字典、服务、组件）。
    2. **所属包内部有无实现**：当前所在包的同级目录是否已有可复用实现，例如
       `shared/src/utils/`（nanoid / dayjs / md5 / tree / dict / zod 等工具）、
       `kits/src/<基础设施>/`（如 `kits/src/redis/`、`kits/src/foundation/`）、`ui/src/components/`。先在包内找，别另起炉灶。
    3. **当前依赖的 npm 包有无实现**：查 `package.json` 已声明的依赖是否直接提供该
       能力——lodash、dayjs、zod、typeorm、@nestjs/*（NestJS DI / 守卫 / 拦截器 / 管道）、
       @tanstack/react-query 等都能覆盖大量通用需求，优先用依赖自身能力
       （如分页 `pageWith` /
        `cursorPageWith` 已由 `@repo/kits` 提供，勿在模块内重写；服务端推送 / SSE 用
        `@repo/kits` 的 `StreamHub` + `@repo/http-client` 的 `HttpStreamClient`，勿自写
        EventSource / 引第三方 SSE 库）。
    4. **现成 npm 包**（联网搜索）：以上都没有，才搜索是否有成熟 npm 包可用，
       优先选择维护活跃、类型完善、体积合理的包（如 id 用 `nanoid`、Redis 用
       `ioredis` 这类既有选型）。
    同时遵循「够用就好的薄封装」原则（教训见 `docs/sdk-refactor.md`）：不为不存在的
    问题引入抽象，不重复实现依赖包或 @repo 包已提供的功能。
11. **语言规范**：所有**用户可见的文案**（错误 label、日志输出信息、提示语、表单 label）、
    代码注释、设计 / 开发文档统一用**简体中文**；代码标识符、事件名、字段名等内部命名
    保持英文（编程惯例，不强制中文化）。
