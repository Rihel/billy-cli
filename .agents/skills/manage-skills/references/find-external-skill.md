# 从外部获取 skill（manage-skills 引用文件）

> 本文件是 `manage-skills` skill 的组成部分。
> 需要联网找现成的 agent skill（「想不到方案时借鉴」的手段之一）时必读。

## 1. 去哪里找

- **agentskills.io**：Agent Skills 标准目录站，可按主题浏览 / 搜索。
- **GitHub**：搜 `<领域> skill`、`awesome-claude-skills`、`awesome-agent-skills` 等仓库。
- **各 agent 生态 skill 目录**：Claude Code（`.claude/skills/`）、OpenAI Codex（`AGENTS.md`
  生态 / skills 仓库）等。
- **find-skills 机制**：当前环境（DSH）自带 `find-skills`，可发现 / 安装现成 skill。

## 2. 怎么搜

- `web_search`：`"<领域> agent skill"`、`"<领域> claude skill"`、`agentskills.io <领域>`。
- 打开候选的 `SKILL.md`，读 **frontmatter 的 `name` + `description`** 判断是否命中需求
  （description 应含 对象 + 任务 + 触发词）。
- 优先**标准格式**：`.agents/skills/<name>/SKILL.md` 或带 YAML frontmatter 的 `SKILL.md`。

## 3. 怎么评估

| 标准 | 说明 |
| --- | --- |
| 命中 | `description` 覆盖你的任务与触发词 |
| 适配 | 技术栈 / 模式与本工程兼容（Hono / InversifyJS / TypeORM / Next.js / antd）或可映射 |
| 质量 | 维护活跃、`SKILL.md` 完整、有参考文件 / 示例 |
| 规范 | 主文件 ≤60 行、references 分层（符合 manage-skills 规范） |
| 克制 | 不过度设计，只需其适用部分 |

## 4. 怎么接入本工程

1. 按 manage-skills 目录规范落地：`.agents/skills/<name>/SKILL.md`，必要时拆 `references/`。
2. **适配而非照抄**：借鉴思想，映射到本工程分层（`placement.md`），不整体搬代码。
3. 在 `billy-dev-foundation/references/catalog.md` 与 `.agents/skills/README.md` 登记。
4. 用 manage-skills 的完成检查清单过一遍（frontmatter / 体积 / 注册 / 同步）。

> 关键：找来的 skill 也要经过「评估 → 适配 → 登记」三步，不能拿来即用；它服务于
> 「打开思路 + 可复用的任务规范」，最终仍要落回本工程的既有模式。
