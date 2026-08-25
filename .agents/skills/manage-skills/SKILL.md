---
name: manage-skills
description: 在 Billy 工程中新增或维护 Agent Skills：判断是否需要新 skill、创建 skill 目录与 SKILL.md、编写 frontmatter（name / description / 触发词）、大文件拆分到 references/、并在 billy-dev-foundation 的「Skill 目录」与 README 中注册；**代码变更（packages / 组件库 / 架构 / 命令）后同步更新受影响的 skill**。触发词：添加 skill、新建 skill、管理 skill、维护 skill、skill 规范、写 skill、拆分 skill、注册 skill、同步 skill、更新 skill、代码变更。
---

# 新增 / 维护 Skill

前置：先加载必读 skill `billy-dev-foundation`（含「Skill 目录」与代码约定）。

## 核心要点

- **先判断**：现有 skill 覆盖或一次性任务都不新建（不重复造轮子）。
- **格式**：`.agents/skills/<kebab-name>/SKILL.md`，frontmatter 含 name（唯一）+ description
  （对象 + 任务 + 触发词）。
- **体积**：主文件 > 约 60 行拆 `references/`，引用文件头部注明归属。
- **注册**：新 skill 登记到 `billy-dev-foundation` 的「Skill 目录」+ `README.md` 速览表。
- **同步**：局部变更（新增导出 / 组件 / 命令）按 maintain-guide 第 2 节 grep 更新；
  **架构变更**（分层 / 依赖方向 / 入口重构）按 maintain-guide 第 3 节专项处理。

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/create-guide.md](./references/create-guide.md) | 新建判断、目录结构、SKILL.md 格式、内容约定 | 新建 skill 时（必读） |
| [references/maintain-guide.md](./references/maintain-guide.md) | 索引注册、代码变更后同步、大文件拆分规则 | 维护 / 同步 / 拆分 skill 时（必读） |

## 完成检查清单

- [ ] 已确认无现有 skill 覆盖该场景（不重复造轮子）
- [ ] 目录 `.agents/skills/<kebab-name>/SKILL.md` 已创建，frontmatter 含 name + description + 触发词
- [ ] 内容基于仓库真实实现；涉及其他 skill 时引用其名称而非重复展开
- [ ] 主文件 > 60 行时已拆分 `references/` 并更新引用
- [ ] 已在 `billy-dev-foundation/SKILL.md` 的「Skill 目录」与 `README.md` 速览表注册
- [ ] 本次代码变更已按 maintain-guide 的「代码变更后的 skill 同步」更新受影响 skill
