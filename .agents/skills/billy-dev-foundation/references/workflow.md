# 标准开发流程与参考实现（billy-dev-foundation 引用文件）

> 本文件是 `billy-dev-foundation` skill 的组成部分，由主 SKILL.md 引用。
> 任务执行过程中按此流程推进，结束时对照主 SKILL.md 的「完成检查清单」自查。

## 标准开发流程

> 动手前先按 `design.md` 评估难度：简单需求直接走下面流程；中等 / 复杂需求先出
> 设计落地方案（位置 + 关键数据结构 + 关键流程 + 测试点），再实现。

1. **读需求，拆到具体位置**：明确涉及哪些层（数据结构 / 数据 / 业务 / 接口 / SDK / 页面），
   同时按 `code-conventions.md` 第 10 条的「实现查找顺序」盘点各层现成实现，
   避免重复造轮子。**先查历史**：按 `AGENTS.md` 的「查证顺序」查（记忆索引 → codegraph →
   `docs/dev-logs/` 的坑点与解法 / `docs/design/` 的设计文档 → 代码），站在前人经验上开工，不重复踩坑。
2. **数据结构先行**：先定义 `@repo/shared` 的 schema 与 dict（含错误码），这是前后端共同的语言。
3. **自底向上实现**：实体（server/database）→ 迁移 → repository / service / errors
   （server/modules）→ controller + module → 模块注册（`root.module.ts` 的 `imports`，
   实体在 `DbModule.forRootAsync` 工厂里补 `entities`）→ SDK → 前端页面。
4. **验证**：`pnpm dev:pkgs` 确保包构建通过 → `pnpm verify`（lint / lint:types / fmt:check / 三道守卫）
   → `pnpm typecheck` / `pnpm test`
   → 起服务后用 `curl -X POST http://localhost:9989/...` 验接口 → 迁移正确执行。
   界面的视觉与交互**不自己跑无头浏览器验**，按下文「验证与收尾清理」第 1 条交给用户。
   **遇到问题先翻日志**：`grep` `docs/dev-logs/` 找历史坑点与解法，复用而非重推。
5. **收尾**：对照主 SKILL.md 的「完成检查清单」自查，确认没有遗漏注册 / 导出。
6. **记录开发日志**：每次开发结束，按「做了什么事 / 坑点 / 怎么解决」三段式记入
   `docs/dev-logs/yyyy-MM-dd.md`（按天追加，单次 ≤500 字符）——写法与示例见
   [dev-log.md](./dev-log.md)。若本次解决了**可复用**的经验（坑点 / 通用模式），
   按 `manage-skills` 的 `harvest-guide.md` **回收沉淀成 skill**。

## 验证与收尾清理

三条硬性要求，每次任务收尾都要对一遍。

### 1. 界面不靠无头浏览器验，交回给用户

不启动 headless Chrome / Playwright / Puppeteer 截图、不做 CDP 注入登录态去「验证」页面。
视觉、布局、交互手感只有人判断得准；机器截图既读不出「好不好看」，还容易在假数据上自证正确。

agent 负责可自动化的部分，然后把**要用户看的点**列成清单一次说清（哪个页面、哪一步操作、
期望看到什么），不要让用户自己去猜你改了什么：

- `pnpm verify`（含 lint / lint:types / fmt:check）/ `pnpm typecheck` / `pnpm test`
- 接口层：`curl` 打接口、`psql` 查落库结果
- 数据与状态：迁移执行结果、日志、用量记录

确实只有浏览器能复现（例如围栏渲染、跨域策略）时，**先说明理由并取得用户同意**再跑，
跑完按第 2、3 条清理。

### 2. 验证用的脚本用完就删

临时脚本（`/tmp` 下的、仓库里临时加的 `scripts/xxx.ts`、一次性的 `node -e` / `python3 -c` 落成的文件）
在验证结束后删除，不留在仓库、不随提交带走。
需要长期复用的，改写成正式脚本、加进 `package.json`，而不是留一个来历不明的临时文件。

### 3. 为测试起的进程收干净

自己起的 dev server / watcher / 一次性服务，收尾时停掉并确认端口释放：

```bash
pnpm kill:dev --dry-run   # 先看会停哪些，确认没误伤别的项目
pnpm kill:dev             # 停掉本仓库的 dev 进程与 watcher
```

不要留下占着 9989 / 9840 / 9845 的孤儿进程让下一个人排查。

## 参考实现

- **完整 CRUD 最小链路**：user 模块——schema
  `packages/shared/src/schema/user.schema.ts` → 实体
  `apps/server/src/database/entities/user-entity.ts` → 业务
  `apps/server/src/modules/user/*`（repository / service / errors）→ HTTP 边界
  `apps/server/src/modules/user/user.controller.ts` + 模块
  `apps/server/src/modules/user/user.module.ts` → SDK
  `packages/sdk/src/server.client.ts` 的 `user` 段 → admin 页
  `apps/admin/src/app/main/system/users/page.tsx`。
- **架构决策与历史**：`README.md`、`docs/sdk-refactor.md`（API 客户端职责划分）。
