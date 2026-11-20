# 管理员类型与「身份 → 归属」换算

**查证优先级：必核**（改 AI 会话 / 工作区 / 凭据 / 技能的归属过滤前复核）

## 结论（2026-11-20，P0 落地）

- **归属唯一入口**：`apps/main/src/common/security/owner.ts` 的 `currentOwner()` / `scopeOf()` /
  `currentAdminType()`。有 `userId` 就是 `user`，只有 `adminId` 才是 `admin`；
  超管（`admins.type='god'`）让 `scopeOf` 返回 `{}`（不过滤），其余返回 `{ ownerType, ownerId }`。
  **禁止**在业务代码里散写 `if (isGod)` 或写死 `ownerType: 'admin'`。
- **管理员类型只认服务端会话**：登录时写进 JWT claim 与 Redis 会话；`AdminService.verifyToken`
  返回 `{ adminId, adminType }`，守卫写入 `requestContext.adminType`。升级前的旧会话没有该字段，
  按 `normal`（最小权限）处理；改类型 / 禁用 / 删除都 `revokeAll` 该账号会话。
- **管理员管理接口挂 `GodAdminGuard`**（菜单隐藏只是交互层）；`AUTH_ENABLED=false`（自托管单租户）
  时该守卫放行。
- **超管来源**：启动期 `AdminSeedService`（`ADMIN_SEED_FROM_ENV` + `GOD_ADMIN_EMAIL/PASSWORD`，
  幂等、失败不阻塞启动、超管被删过只告警不重建）；运维恢复走 `pnpm seed:admin`（同一段
  `AdminService.seedGod`，邮箱已存在只升级类型、不动密码）。迁移里不写任何账号。
- **默认工作区按 owner 懒创建**：管理员建号时建；用户端没有建工作区入口，在**首次建会话**时
  `ensureDefault`，否则 `bash` 永远返回「会话还没有绑定工作区」。

## 坑（都踩过）

- **`repo.insert()` 不触发 `@BeforeInsert`**：实体 id 由 `@BeforeInsert` 生成，用 InsertQueryBuilder 会撞
  `id NOT NULL`。要 id 就走 `save(create(...))`，或显式传 id。
- **事务里别放"尽力而为"的附属写**：建号事务里调 `ensureDefault`，它失败后 Postgres 把事务打成 aborted，
  COMMIT 变回滚 —— **账号静默消失但接口返回成功**。附属动作要么不在同一个事务里（`create` 已去掉
  `@Transactional()`），要么拆成独立事务。

## 依据

- `docs/design/workspace-cli-credentials.md` §6.10 / §9.1（P0）
- `packages/db/src/entities/admin-entity.ts`、`packages/db/src/migrations/1795060000000-AddAdminType.ts`
- `apps/main/src/modules/admin/{admin.service,admin-seed.service,admin-type-rules,god-admin.guard}.ts`
- 核对：
  ```bash
  grep -n "currentOwner\|scopeOf" -r apps/main/src --include=*.ts
  grep -n "adminType" packages/kits/src/http/request-context/request-context.ts packages/kits/src/session/session-store.ts
  PGPASSWORD=pg1234 psql -h localhost -U root -d billy-cli -c "select email,type from admins where deleted_at is null"
  ```

## 失效信号

凭据 / 技能模块改用别的归属函数；`scopeOf` 之外出现新的过滤分支；`admins.type` 被换成枚举表或角色树；
会话不再携带 `adminType`（改成每请求查库）。
