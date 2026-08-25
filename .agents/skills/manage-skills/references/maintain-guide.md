# 维护 Skill（manage-skills 引用文件）

> 本文件是 `manage-skills` skill 的组成部分，由主 SKILL.md 引用。
> 维护 / 同步 / 拆分 skill 时必读。

## 1. 注册（必做，否则新 skill 不会被发现）

新 skill 必须登记到两处索引，保持一致：

1. `billy-dev-foundation/SKILL.md` 的 **「Skill 目录」** 表加一行（skill 链接 + 用途 + 何时加载）。
2. `.agents/skills/README.md` 的速览表加一行。

## 2. 代码变更后的 skill 同步（局部变更）

skill 描述的是仓库现状：**当 packages / 前端发生变化时，必须同步更新受影响的
skill**，否则 agent 会按过时规范写代码。触发场景：

- `packages/*` 新增或修改导出：新工具函数、新 schema 基类、新分页策略、新 aui/ui 组件
- 组件库变化：组件新增 / 改名 / props 变更（`@repo/aui`、`@repo/ui`）
- 文件移动 / 入口改名（**结构性架构变更走第 3 节**）
- 命令变化：新增 / 修改 package.json scripts（dev / db:gen / test 等）
- 依赖升级：重要依赖用法变化（zod / typeorm / antd 等）

更新流程：

1. **识别影响面**：`grep -rn "<被改动的包 / 文件 / 组件名>" .agents/skills`，
   找出引用了该内容的 skill 与 references 文件。
2. **逐处更新**：修正参考路径、组件清单、命令、代码片段，使其与新实现一致。
3. **控制体积**：更新后主文件超过约 60 行或新增内容可独立成主题时，按本文第 4 节拆分规则
   迁到 references/。
4. **校验**：重新 grep 确认无过时引用；frontmatter 不变则无需重新注册。

> 历史实例：曾把 `apps/server/src/app.ts` 合并进 `main.ts`，当时同步更新了 foundation
> 检查清单、develop-business-module 的路由挂载步骤与 README 结构图——「改代码 + 改 skill」
> 必须一起完成，不要只改一半。

## 3. 架构变更的专项处理（区别于普通代码变更）

架构变更（分层调整、包职责 / 依赖方向变化、入口重构、数据流变化）会推翻 skill 的
**骨架**——分层心智模型、依赖方向铁律、落点清单、目录约定——不能只用第 2 节的
「grep 改路径」流程，要专项处理：

1. **影响评估**：列出被推翻的核心假设——哪些 skill 的分层图、铁律、落点清单失效
   （不止是路径变了，是「结构」变了）。
2. **先改 foundation**：`billy-dev-foundation` 的 `references/architecture.md`（分层图 /
   数据流）与 `references/code-conventions.md`（铁律 / 目录约定）是其他 skill 的
   心智模型来源，必须**最先**更新，否则下游 skill 全站在旧骨架上。
3. **再改受影响的功能 skill**：按依赖方向更新落点清单、参考路径、代码模板
   （如 develop-business-module 的 8 落点、define-data-structure 的注册点）。
4. **评估 skill 划分是否要变**：架构变了，原 skill 边界可能不再合理——该合并 / 新增 /
   删除（走 create-guide 的「先判断」）。
5. **复审**：架构变更影响面大，更新后建议重新跑一轮 skill 审查（如多 reviewer 分头
   核对每个 skill 与真实代码一致），而非只靠 grep。

实例：若分层从 `server → core → db/shared` 改为新结构，foundation 分层图、
develop-business-module 的 8 落点、define-data-structure 的注册点都要动，而非只改路径。

## 4. 大文件拆分规则

- 主 SKILL.md 超过约 60 行，或内容可独立成主题（架构、命令、流程、约定）时，拆到
  `references/` 子目录，主文件用相对链接引用并标注「必读 / 何时读」。
- references 文件开头用 blockquote 注明归属，例如：
  `> 本文件是 <skill-name> skill 的组成部分，由主 SKILL.md 引用。`
- 拆分后同步更新主文件的「参考文件」清单与所有指向旧章节的外部引用。
