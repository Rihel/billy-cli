# 新建 Skill（manage-skills 引用文件）

> 本文件是 `manage-skills` skill 的组成部分，由主 SKILL.md 引用。
> 新建 skill 时必读。

## 1. 先判断：真的需要新 skill 吗？

按「不重复造轮子」原则（`billy-dev-foundation/references/code-conventions.md` 第 10 条）
检查：

- 现有 skill 是否已覆盖该场景？是 → 复用或扩展现有 skill，**不新建**。
- 需求是"一次性的具体任务"而非"可复用的任务规范"？是 → 不要建 skill。
- 只有**会反复出现、有明确规范与产出的任务**才值得建 skill（如定义字典、定义结构、开发模块）。

## 2. 目录结构规范

```
.agents/skills/<skill-name>/          # skill-name 用 kebab-case，语义化，全局唯一
├── SKILL.md                          # 必须：frontmatter + 正文
└── references/                       # 主文件超过约 60 行时拆分到这里
    ├── <topic>.md                    # 每个文件头部注明「本文件是 <skill-name> skill 的组成部分」
    └── ...
```

- 辅助文件（模板、示例代码、脚本）可放在 skill 目录内，SKILL.md 用相对路径引用。
- 主文件保持精简，只留：定位与触发说明、核心决策、参考文件清单（含"何时读"）、
  完成检查清单。

## 3. SKILL.md 格式规范

frontmatter（YAML，必须有）：

```markdown
---
name: <skill-name>                      # kebab-case，与目录名一致，全局唯一
description: <一句话说明：对象 + 任务 + 触发词>
---
```

description 写作要点（agent 靠它决定是否加载本 skill）：
- **对象**：Billy 工程 / 哪个包或层。
- **任务**：这个 skill 让 agent 做什么、产出什么。
- **触发词**：中文 + 关键英文词，覆盖用户可能的说法（如"定义字典、枚举、错误码、Dict"）。

正文结构建议：

```markdown
# 标题

前置：先加载必读 skill `billy-dev-foundation`（...）。

## 核心要点          # 该任务必须遵守的规则与步骤（精炼）
## 参考文件          # 指向 references/，含"何时读"
## 完成检查清单      # 收尾自查项
```

## 4. 内容约定

1. 所有代码片段、路径、组件名必须以仓库真实实现为准（先读原文件再写，不凭印象）。
2. 涉及其他 skill 的能力时，引用其 skill 名与目录（如 `define-dict-enum`），不重复展开。
3. 遵守工程的硬性约定（导入后缀、错误体系、DI 注册等，见
   `billy-dev-foundation/references/code-conventions.md`）。
4. 文件路径用仓库根相对路径（如 `packages/shared/src/dicts/`），不要用绝对路径。
