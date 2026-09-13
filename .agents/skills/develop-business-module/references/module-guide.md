# 业务模块实现详解（develop-business-module 引用文件）

> 本文件是 `develop-business-module` skill 的组成部分，由主 SKILL.md 引用。
> 实现模块时按各节落地，最后按主 SKILL.md 的检查清单自查。

## 0. 骨架生成（可选，推荐）

新模块骨架可用代码生成器一键生成（对齐 todo 范例的 entity / repository /
service / errors / controller / module / schema）：

```bash
pnpm cli -t crud -n <name>
```

生成后仍需按下列各节逐层落地：错误码与 schema 导出、`XxxModule` 在
`apps/server/src/root.module.ts` 的 `imports` 注册 + 实体注入
`DbModule.forRootAsync` 工厂的 `entities`、迁移、SDK、admin 页面。

## 1. ① 契约：错误码 + schema

- `AppErrorCodes` 增加 `XxxNotFound: { label: 'Xxx 不存在', value: 3xxx, http: 404 }`
  及模块内其他错误（value 从 3xxx 起连续分配，不与其他模块冲突）。
- schema 与 DTO 的完整规范见 `define-data-structure` skill（模型 / Create / Update /
  GetDetail / Remove / PageQuery / CursorQuery），此处不重复展开。

## 2. ② 数据：实体 + 迁移

- `xxx-entity.ts` 继承 `BaseEntity`；游标排序配 `(updatedAt, id)` 索引。
- 实体 / schema 双轨、注册、迁移的完整规范见 `define-data-structure` skill。

## 3. ③ 业务（server/modules，核心工作量）

目录 `apps/server/src/modules/xxx/`（**包内相对导入带 `.js` 后缀**）。

### errors.ts

```ts
import { AppErrorCodes } from '@repo/shared'
import { AppError } from '@repo/kits'

export class XxxNotFoundError extends AppError {
  readonly code = AppErrorCodes.XxxNotFound
  constructor(readonly xxxId: string) {
    super(`Xxx not found: ${xxxId}`)
  }
}
```

### xxx.repository.ts（数据访问）

```ts
@Injectable()
export class XxxRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  private async repo() {
    return this.db.getRepository(XxxEntity)
  }

  // create：repo.save(repo.create(data))，返回模型
  // findById / update / remove：先 findOneBy({ id })，不存在返回 null（业务层负责抛错）
  // update / remove 用「先查后改」：findOneBy → Object.assign → save / repo.remove
  // page：createQueryBuilder + pageWith(builder, page, size)，关键字用 ILIKE
  // cursor：createQueryBuilder + cursorPageWith(builder, { cursorColumns, getCursor, order, size })
}
```

要点：`pageWith` / `cursorPageWith` 来自 `@repo/kits`（`packages/kits/src/db/pagination.ts`）；
返回值统一经 `toXxx()` 映射为模型（剥离 `deletedAt` 等内部字段）；查询参数来自 DTO，
不要直接信任前端字符串拼接。

### xxx.service.ts（业务逻辑 + 事务 + 日志）

```ts
@Injectable()
export class XxxService {
  constructor(
    @Inject(XxxRepository) private readonly xxxRepository: XxxRepository,
    // 日志固定构造器注入（AppLogger 来自 @repo/kits），不要用已删除的 @Logger() 装饰器
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  @Transactional()   // 写操作必须加事务
  async create(input: CreateXxxDto): Promise<XxxModel> { ... }

  async get(input: GetDetailXxxDto): Promise<XxxModel> {
    const row = await this.xxxRepository.findById(input.xxxId)
    if (!row) throw new XxxNotFoundError(input.xxxId)   // 唯一抛错方式
    return row
  }

  async page(query: PageQueryXxxDto): Promise<PageQueryResult<XxxModel>> { ... }

  // 写操作套路：校验 → 调 repository → 失败抛对应错误 → logger.log('xxx.updated', { id })
}
```

### xxx.module.ts + index.ts（模块注册）

1. 模块 `index.ts`：`export * from './errors.js'`、`./xxx.repository.js`、`./xxx.service.js`、
   `./xxx.controller.js`、`./xxx.module.js`（模块内部聚合导出，无自动注册语义）。
2. 在 `apps/server/src/modules/xxx/xxx.module.ts` 声明 provider 与 controller：

   ```ts
   @Module({
     imports: [AdminModule],       // 复用 AdminAuthGuard 时按需导入
     controllers: [XxxController],
     providers: [XxxRepository, XxxService],
   })
   export class XxxModule {}
   ```

3. 在 `apps/server/src/root.module.ts` 的 `imports` 里加 `<Xxx>Module`：没有副作用入口，
   也没有自动注册，**漏了这一步 Nest 不会加载该模块，路由直接 404**。
   实体另在 `root.module.ts` 的 `DbModule.forRootAsync` 工厂里补进 `entities: [...]`
   （其余 `db` 配置来自 `config.get('db')`），见 `define-data-structure`。

## 4. ④ Controller（HTTP 边界）

```ts
// apps/server/src/modules/xxx/xxx.controller.ts（参考 modules/todo/todo.controller.ts）
@Controller('xxx')
@UseGuards(AdminAuthGuard)
export class XxxController {
  constructor(@Inject(XxxService) private readonly xxxService: XxxService) {}

  @Post('create')
  @HttpCode(200)
  create(@Body({ schema: CreateXxxSchema }) input: CreateXxxDto) {
    return this.xxxService.create(input)
  }

  @Post('page-query')
  @HttpCode(200)
  pageQuery(@Body({ schema: PageQueryXxxSchema }) input: PageQueryXxxDto) {
    return this.xxxService.page(input)
  }

  // ... detail / update / remove 同构
}
```

要点：
- Nest 对 POST 默认返回 201，必须显式 `@HttpCode(200)`；所有业务路由统一 POST。
- 入参一律 `@Body({ schema: Schema })`；返回数据由全局 `ResponseEnvelopeInterceptor` 包
  `{ code: 0, data }`，controller 不手写响应信封。
- 构造器参数必须显式 `@Inject(token)`：项目用 tsx（esbuild）不产出 `design:paramtypes`，
  漏写会静默注入 undefined（第 6 条铁律，见 `billy-dev-foundation`）。

鉴权按需选择（细节见 `implement-auth` skill）：
- 用户接口：`@UseGuards(UserAuthGuard)`（`modules/auth/user-auth.guard.ts`）。
- 管理员接口：`@UseGuards(AdminAuthGuard)`（`modules/admin/admin-auth.guard.ts`）。
- 公开接口：不加守卫，handler 内按需处理。

## 5. ⑤ SDK（全类型化客户端）

`packages/sdk/src/server.client.ts` 的 `ServerClient` 增加一段：

```ts
xxx = {
  create: (data: CreateXxxDto) => this.post<XxxModel>('/xxx/create', data),

  pageQuery: (data: PageQueryXxxDto) =>
    this.post<AppPageQueryResponse<XxxModel>>('/xxx/page-query', data),

  detail: (data: GetDetailXxxDto) => this.post<XxxModel>('/xxx/detail', data),

  update: (data: UpdateXxxDto) => this.post<XxxModel>('/xxx/update', data),

  remove: (data: RemoveXxxDto) =>
    this.post<SuccessResultModel>('/xxx/remove', data),
}
```

注意：顶部 `@repo/shared` 的 type import 列表要补上新类型；返回类型用模型 / 响应类型，
禁止 `any`。

## 6. ⑥ admin 页面（可选，按需）

页面实现（DataTable / DataList / ModalForm / useMutation + immer 缓存更新等）见
`develop-frontend-page` skill，此处不重复展开。要点：`apps/admin/src/app/main/xxx/page.tsx`
`'use client'`；菜单加进 `apps/admin/src/components/AppMenu.tsx`；守卫由 `proxy.ts` +
`main/layout.tsx` 统一处理，新页面无需重复。

## 7. 验证

1. `pnpm dev:pkgs` 确认 packages 构建通过（改包的代码必须重新构建，前端 / 服务端才能拿到）。
2. `pnpm dev:server` 起服务；自测接口：
   ```bash
   curl -X POST http://localhost:9989/xxx/create \
     -H 'Content-Type: application/json' \
     -H 'Authorization: Bearer <token>' \
     -d '{"...": "..."}'
   ```
3. 错误路径验证：不存在的 id 应返回 `{ code: 3xxx, message: 'Xxx 不存在' }` 且 HTTP 404。
4. 页面自测：增删改查 + 分页 / 关键字搜索 + 字典列展示。
5. 最后对照 `billy-dev-foundation` 主文件的「完成检查清单」逐项自查。
