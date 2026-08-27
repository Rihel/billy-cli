# 硬性代码约定（billy-dev-foundation 引用文件）

> 本文件是 `billy-dev-foundation` skill 的组成部分，由主 SKILL.md 引用。
> **写任何代码前先阅读并遵守以下约定。**

1. **包内相对导入后缀**：`@repo/kits`、`@repo/di`、`apps/server` 内相对导入带 `.js` 后缀
   （如 `'./errors.js'`、`'../lib/http.js'`）；`@repo/shared` 及前端 app 不带后缀。
   **新代码跟随所在包的既有风格，不混用**。跨包一律 `@repo/*`（如 `@repo/kits`、
   `@repo/shared`、`@repo/shared/logger` 子路径）。
2. **错误体系**：业务 / 基础设施错误必须继承 `AppError`
   （`packages/kits/src/foundation/errors/app-error.ts`），提供只读 `code`
   （来自 `AppErrorCodes`）。边界自动映射 HTTP + 中文，禁止在 server 层手写错误文案。
3. **错误码分段**（`packages/shared/src/dicts/app-error-code.dict.ts`）：
   `1xxx` 认证、`2xxx` 用户 / 管理员、`3xxx` 业务模块（新模块从这里起段）、
   `4xxx` 输入校验、`5xxx` 系统。
4. **统一响应格式**：成功 `{ code: 0, data }`；分页 `{ items, total, page, size }`；
   游标 `{ items, nextCursor }`（见 `@repo/shared` 的 `AppResponse` / `AppPageQueryResponse` /
   `AppCursorQueryResponse`）。所有业务接口统一 `POST + JSON body`，不用 REST 动词。
5. **DI**：业务类用 `@Injectable()`，构造器参数用 `@Inject(Token)`
   （均来自独立包 `@repo/di`）；日志用 `@Logger()` 注入 `AppLogger`；
   写操作加 `@Transactional()`（来自 `@repo/kits` 的 re-export）；**新增的 service / repository
   必须注册到 `apps/server/src/main.ts`**（应用组合根，`addService` 即可；生命周期组件在
   `createServiceContext` 内用 `addLifeCycleService`）。
6. **实体**（`apps/server/src/database/entities/`）：继承 `BaseEntity`（来自 `@repo/kits`，
   自动 id = nanoid(20)、
   created_at / updated_at / deleted_at 均为 timestamp(3)）；表名复数；列名 snake_case、
   字段名 camelCase；索引 / 唯一约束显式命名（`idx_*` / `uk_*`）。软删除 + 唯一约束
   必须把 `deletedAt` 纳入唯一键（如 `@Unique('uk_user_email', ['email', 'deletedAt'])`）。
7. **命名**：文件 `kebab-case`；DTO 类型统一 `XxxDto`（`z.infer` 结果）；模型 `XxxModel`；
   实体 `XxxEntity`；类名 PascalCase。
8. **前端**：admin 页面一律 `'use client'` + `@repo/aui`（DataTable / DataList /
   ModalForm / ConfirmAction / PageToolbar 等）+ TanStack Query（useQuery / useMutation）+
   `useServerClient()`；web 用 Base UI + shadcn + Tailwind 4，不引 Ant Design。
9. **纯类型导入用 `import type`**：`apps/server` 开启 `verbatimModuleSyntax`，值 / 类型
   混用导入会报错；其余 packages 虽未开启，仍统一用 `import type` 区分纯类型，保持风格一致。
10. **不要重复造轮子（实现查找顺序，最高优先）**：任何功能实现之前，先按以下顺序
    查找现成实现，**全部都没有才允许自己写**：
    1. **各个包有无实现**：`packages/*`（shared / kits / di / sdk / api-client / ui /
       aui）里是否已有类似能力（工具函数、schema、字典、服务、组件）。
    2. **所属包内部有无实现**：当前所在包的同级目录是否已有可复用实现，例如
       `shared/src/utils/`（nanoid / dayjs / md5 / tree / dict / zod 等工具）、
       `kits/src/foundation/`、`aui/src/components/`。先在包内找，别另起炉灶。
    3. **当前依赖的 npm 包有无实现**：查 `package.json` 已声明的依赖是否直接提供该
       能力——lodash、dayjs、zod、typeorm、hono、@repo/di（InversifyJS 门面）、
       @tanstack/react-query、antd 等都能覆盖大量通用需求，优先用依赖自身能力
       （如分页 `pageWith` /
       `cursorPageWith` 已由 `@repo/kits` 提供，勿在模块内重写）。
    4. **现成 npm 包**（联网搜索）：以上都没有，才搜索是否有成熟 npm 包可用，
       优先选择维护活跃、类型完善、体积合理的包（如 id 用 `nanoid`、Redis 用
       `ioredis` 这类既有选型）。
    同时遵循「够用就好的薄封装」原则（教训见 `docs/sdk-refactor.md`）：不为不存在的
    问题引入抽象，不重复实现依赖包或 @repo 包已提供的功能。
11. **语言规范**：所有**用户可见的文案**（错误 label、日志输出信息、提示语、表单 label）、
    代码注释、设计 / 开发文档统一用**简体中文**；代码标识符、事件名、字段名等内部命名
    保持英文（编程惯例，不强制中文化）。
