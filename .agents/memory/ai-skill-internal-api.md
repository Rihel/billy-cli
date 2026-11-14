# skill 管理工具留在 agent-runtime 本地执行（旧 internal API 删除）

> 查证优先级：必核 —— 确认 worker 不再注册 skill-*。

## 决策（2026-11-14）

- `skill-*` 是**管理面**工具，不属于 worker 执行平面；worker 不注册、不回调。
- 执行在 **agent-runtime** 本地（`modules/ai/skills/skill.tools.ts` + `SkillLibraryService`，
  依赖 Mastra 的技能内容校验 / 落盘）；main 只做后台 CRUD 并广播 `ai.skill.changed`。
- gateway 目录里的 `executor: 'server'` 是历史命名（拆分前只有 server），实际落在 runtime 本地。
- 旧 `/internal/ai/skill/execute`、`SkillDataClient`、`InternalSkill*` 已删除。
- 数据流不再有 worker→控制面。
