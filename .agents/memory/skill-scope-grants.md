# 技能归属与授权（P9）

**查证优先级：必核**（改技能唯一性 / 归属过滤 / 物化前复核）

## 结论（2026-11-20，P9 第一步已落地）

- **唯一性的边界是「可见集合」**：`ai_skills` 的 `uk_skill_key` 已删除，改为两条软删感知的部分唯一索引：
  `uk_skill_platform (skill_key) WHERE scope='platform'` 与
  `uk_skill_personal (owner_type, owner_id, skill_key) WHERE scope='personal'`。
  理由是别人的个人技能不会进入我的容器，全库唯一会让先占名字的人影响其他人。
- **归属列**：`scope`（platform / personal，默认 platform）、`owner_type` / `owner_id`（personal 必填）。
- **授权表**：`ai_skill_grants`（`skill_key` + `principal_type` user/admin/all + `principal_id`，`all` 时 id=`*`），
  平台技能默认不开放；个人技能不走授权表（仅 owner 可见）。
- **按 caller 过滤已落地**：`apps/workspace-service/src/workspace/skill-visibility.ts` 的 `visibleSkillsOf`
  （内置全员 / 平台需授予 / 个人仅 owner / 同名个人优先），初始化物化走 `listVisibleSkills(caller)`。
  超管全量：执行面读一次 `admins.type`（`AdminEntity` 已登记），god 可见全部平台技能。
- **授权接口 + 管理页已落地**：`/ai-skill/grants/{list,set}`（覆盖式，空数组=收回全部）与 `/main/ai/skills/grants` 页面，
  写入 `ai_skill_grants` 后直接改变 `visibleSkillsOf` 的物化结果。**坑**：`repo.insert` 不触发
  `@BeforeInsert`，必须显式给 id（这次在 grants 上又遇到一次）。
- **写入目标由身份决定（P9 第四步）**：`skill-scope.ts` 的 `resolveSkillWriteTarget`（用户→personal、
  god→platform、普通管理员→自身 personal、无上下文→platform）已在 `skill.service.create` 生效；
  入参 `scope` 不参与（D12）。**注意**：update / remove / read 仍是全库按 skillKey 定位，
  等个人技能真正开给用户端时必须补可见性校验。
- **撤销同步已落地**：执行面 `syncSkills`（写可见 + 删不可见 `.agents/<key>`，目录名白名单防注入），
  `/v1/workspaces/sync` 带 `skills` 开关；main `SkillSyncService` 在 `SkillGrantService.set` 后按
  「变更前后并集」推送（只查不起，失败由 ensure 兜底）。`all` 授权会广播到全部工作区（仍只推运行中的）。
- **配额已落地**：个人技能上限 50（`create` 前查 `countPersonal`，超限 3601）；单文件 1 MB 与管理员可见范围待补。
- **尚未实现（P9 剩余）**：
  授权接口 / 页面、撤销授权后的目录删除同步、builtin 种子化、删除 `AI_SKILLS_DIRS`、个人技能配额与管理员可见范围。
  `AI_SKILLS_DIRS` 已删除（技能只来自随包 catalog + 技能库落盘投影）；Mastra 技能工具已退役。

## 提示词与工具面（P10 进度）

- `requirements.eta` 已改为「`file-read` 读 `.agents/<技能名>/SKILL.md`」、禁止手写 `.agents/`、
  收尾主动问是否保存（凭据 / 安装项 / 技能）。
- **Mastra `skill` / `skill_search` / `skill_read` 已退役**（2026-11-20）：目录改由
  `buildRuntimeContext` 用 `SkillLoader` 渲染 `## 可用技能` 追加进 system，`ai.mastra.ts` 传 `skills: []`。
  主会话与子 agent 共用 `skillCatalogSection`，子 agent 也会带目录段；正文靠 `file-read` 读 `.agents/`。

## 依据

- `docs/design/workspace-cli-credentials.md` §6.7
- `packages/db/src/entities/ai-skill-entity.ts`、`ai-skill-grant-entity.ts`、`migrations/1795187070810-AddSkillScopes.ts`
- 核对：
  ```bash
  PGPASSWORD=pg1234 psql -h localhost -U root -d billy-cli -c "\d ai_skills" -c "\d ai_skill_grants"
  grep -n "uk_skill_platform\|uk_skill_personal" packages/db/src/entities/ai-skill-entity.ts
  ```

## 失效信号

技能唯一性改回全库 / 出现角色树 / 个人技能改用独立表。
