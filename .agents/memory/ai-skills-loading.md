# 技能加载：我们只发现/校验/授权，内容交给 Mastra 按需读

**查证优先级：抽核**（改技能目录机制、升 Mastra 大版本时复核）

## 结论

- `SkillLoader` 只做三件事：**扫目录发现**、**启动期校验**（`validateSkillContent`）、
  **按名字给出技能目录绝对路径**。正文 / `references/` **不进内存**。
- 路径交给 `Agent({ skills: [<绝对路径>] })` 后，由 Mastra 的 `LocalSkillSource` / `WorkspaceSkills`
  负责：清单（名字 + 描述）作为 system message 注入，正文与参考文件由 `skill` / `skill_read` 工具按需读
  （渐进披露）。
- 目录 = `core/skills/catalog/`（随部署打包，**坏技能 = 启动失败**）+ `AgentConfig.skillsDirs`
  （默认 `~/.agents/skills`，`AGENT_SKILLS_DIRS` 逗号分隔；**坏一个只跳过 + 错误日志**，重名前面赢）。
- `skills: ['*']`（`ALL_SKILLS`）在**装配期展开成真实名字**，所以 `/agent/list` 与
  `runs.request_snapshot.skillKeys` 里是具体技能名。

## 实测数字（2026-10-27，`~/.agents/skills` 24 个技能）

- 装进 **23** 个：`xilo-opus-video` 的 description 超 1024 字符（Mastra 的 `MAX_DESCRIPTION_LENGTH`）被跳过；
- `POST /agent/list` → assistant `skills` 23 条；一问"你能用哪些技能"能答出
  `ant-design / impeccable / minimalist-ui / shadcn / humanizer-zh`；
- **成本**：该轮 `inputTokens = 15690`，而我们自己估的 `context.estimatedInputTokens = 4004`
  （只覆盖我们组装的提示词，不含 Mastra 之后注入的技能清单）—— 每轮多约 11k token。
  嫌贵就瘦身技能 description 或把 `skills` 收窄成白名单。

## 坑

- `WorkspaceSkills.getReference(name, path)` 的 path 是**相对技能目录**的（要写 `references/x.md`），
  只写 `x.md` 会返回 `null`。
- Mastra 校验只对 name（≤64）/ description（≤1024）/ compatibility（≤500）硬拦；
  正文 5000 token / 500 行只是**警告**，不拦启动。
- 别把外部目录的坏技能做成启动失败：第三方技能库一个 typo 能让整个服务起不来（这正是"分级严格"的原因）。

## 依据

- `apps/server/src/modules/ai/core/skills/skill.loader.ts`（发现 / 校验 / `SKILL_DIRS`）
- `apps/server/src/modules/ai/mastra/skill.adapter.ts`（`SkillRef[] → 目录路径[]`）
- `apps/server/src/modules/ai/agents/index.ts`（`ALL_SKILLS` 装配期展开）、`ai.module.ts`（`SKILL_DIRS` 供给）
- `apps/server/test/ai-skills-loader.test.ts`（含"路径交给 `resolveAgentSkills` 后能列表并读到 references"）
- `docs/design/ai-agent.md` §1.4、`docs/dev-logs/2026-10-27.md`
