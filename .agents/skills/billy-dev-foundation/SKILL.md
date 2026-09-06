---
name: billy-dev-foundation
description: Billy 工程（billy-cli monorepo）开发必读 skill。任何在本仓库进行开发、重构、修 bug、加接口或功能之前，必须先加载本 skill，了解分层架构、目录约定、命名规则、常用命令与标准开发流程。触发词：billy、开发规范、分层、架构、monorepo、加功能、改接口、重构、代码约定、CRUD、全栈。
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
与组合根的归属（`modules/` 不 import Hono，与 `features/` 物理分层），按依赖方向自底向上
落代码（架构见 [references/architecture.md](./references/architecture.md)）。

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/architecture.md](./references/architecture.md) | 工程定位、技术栈、分层架构详解、数据流 | 每次任务开始（必读） |
| [references/placement.md](./references/placement.md) | 能力归位决策：新能力该放哪个包 / 目录 / 文件，各落点的模式要求 | 遇到无基础能力的新需求（状态机 / 队列 / 心跳 / 限流等）时（必读） |
| [references/design.md](./references/design.md) | 设计决策：评估难度决定是否出方案、方案原则、借鉴成熟方案 | 中等 / 复杂需求动手前（必读） |
| [references/code-conventions.md](./references/code-conventions.md) | 硬性代码约定 10 条，含「不重复造轮子」查找顺序 | 写任何代码前（必读） |
| [references/commands.md](./references/commands.md) | 常用命令 | 需要执行命令时 |
| [references/workflow.md](./references/workflow.md) | 标准开发流程、参考实现（todo 全链路） | 任务执行过程中 |

## 完成检查清单

- [ ] schema / dict / entity 三者字段一致，且都已在对应 `index.ts` 导出
- [ ] 新实体已放入 `apps/server/src/database/entities/`，并在 `apps/server/src/main.ts` 的
  `createServiceContext({ db: { entities } })` 注入，且已生成 + 执行迁移
- [ ] 新 service / repository 已在 `apps/server/src/modules/index.ts` 副作用导入（@Injectable
  自动登记 + runtime.autoRegister() 自动装配；实现 OnAppStart/OnAppStop 钩子自动按生命周期
  组件装配），且新模块已在 `apps/server/src/modules/<业务>/index.ts` 导出
- [ ] 错误全部继承 `AppError` 且 code 已在 `AppErrorCodes` 中定义（3xxx 段）
- [ ] 路由已在 `apps/server/src/main.ts` 挂载，SDK 已补全类型化方法
- [ ] admin 页面已加入 `apps/admin/src/components/AppMenu.tsx` 菜单
- [ ] 相对导入后缀与所在包既有风格一致；纯类型用 `import type`
- [ ] 改动触及 skill 提到的包 / 组件 / 命令时，已按 `manage-skills` 的「代码变更后的 skill 同步」更新相关 skill
- [ ] 未重复造轮子：已按「实现查找顺序」确认无现成实现
- [ ] 已把本次开发记录追加到 `docs/dev-logs/yyyy-MM-dd.md`（单次 ≤500 字符）
- [ ] 输出文案 / 程序日志 / 注释 / 文档均为简体中文
- [ ] `pnpm dev:pkgs` 与目标 app 类型检查通过
