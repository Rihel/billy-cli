---
name: develop-business-module
description: 在 Billy 工程中开发完整业务模块（如商品、订单、文章等 CRUD 或新功能），覆盖契约 → 数据 → 业务 → 接口 → SDK → 前端页面的全链路。触发词：开发业务模块、新增模块、新功能、CRUD、业务接口、列表页、表单页、写接口、后端接口、管理页面。
---

# 开发业务模块

前置：先加载必读 skill `billy-dev-foundation`（「不重复造轮子」实现查找顺序见其
`references/code-conventions.md` 第 10 条）；涉及字典 / 表结构时加载 `define-dict-enum`、
`define-data-structure`；写页面时加载 `develop-frontend-page`。

## 模块全景（8 个落点）

以新增模块 `xxx`（如 product）为例，完整链路：

```
① dicts（错误码）   packages/shared/src/dicts/app-error-code.dict.ts（3xxx 段）
② schema（契约）    packages/shared/src/schema/xxx.schema.ts        → 见 define-data-structure
③ entity（表）      packages/db/src/entities/xxx-entity.ts + db/index.ts + db.ts
④ 迁移              pnpm db:gen Xxx / pnpm db:migrate
⑤ core 业务         packages/core/src/modules/xxx/{errors,repository,service,index}.ts
                    + core/src/index.ts + runtime.ts（三处注册，缺一不可）
⑥ Hono 路由         apps/server/src/features/xxx.ts + main.ts 挂载   → 鉴权见 implement-auth
⑦ SDK               packages/sdk/src/server.client.ts
⑧ admin 页面        apps/admin/src/app/main/xxx/page.tsx + AppMenu.tsx → 见 develop-frontend-page
```

**推荐顺序**：先 ①② 定契约 → ③④ 落数据 → ⑤⑥⑦ 打通接口 → ⑧ 出页面。
**参考实现**：todo 模块（schema / entity / core `modules/todo/*` / `features/todo.ts` /
SDK `todo` 段 / `main/todo/page.tsx`），拿不准直接照抄。
**每一层实现前先按「实现查找顺序」确认现成能力**：分页 `pageWith` / `cursorPageWith`、
aui 组件、schema 基类、SDK 既有方法——全部没有才自己写。

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/module-guide.md](./references/module-guide.md) | 各层代码模板、DI 三处注册、路由 / SDK 写法、验证 | 实现模块时（必读） |

## 完成检查清单

- [ ] 错误码已加入 `AppErrorCodes`（3xxx 段）；schema 已注册 `schema/index.ts`
- [ ] 实体已注册 `db/index.ts` + `db.ts`；迁移已生成并执行
- [ ] core 三处注册齐：模块 `index.ts` + `packages/core/src/index.ts` + `runtime.ts`
- [ ] 路由已在 `main.ts` 挂载，鉴权策略明确；SDK 已补类型化方法
- [ ] admin 页面已加进 `AppMenu.tsx`；增删改查 + 分页 + 错误路径自测通过
- [ ] 对照 `billy-dev-foundation` 完成检查清单逐项自查
