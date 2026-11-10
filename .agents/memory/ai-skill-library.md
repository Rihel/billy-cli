# 技能库：DB 是事实源，磁盘只是给 Mastra 的投影

**查证优先级：必核**（改技能加载 / 落盘 / 导入 / admin 技能页前复核）

## 结论

- 库 = `ai_skills` + `ai_skill_files`；落盘 = `SkillMaterializer` 写到
  `AgentConfig.skillsLibraryDir`（默认 `~/.billy/skills`，env `AGENT_SKILLS_LIBRARY_DIR`）。
  **这个目录由我们独占**：启动 `syncAll` 会删掉库里不存在的一级目录。
- `SkillLoader` 扫描顺序：`catalog/`（严格）→ **技能库目录** → `AGENT_SKILLS_DIRS`（默认 `~/.agents/skills`）。
  库里启用的技能赢过外部同名技能。
- agent 声明的 `skills: ['*']` **不再装配期展开**：`SkillLoader.resolve('*')` 在每次运行组装信封时现算，
  Mastra 侧 `skills` 是动态函数（`ai.mastra.ts`）。在线新建 / 停用不需要重启。
- 停用 = `enabled=false` + **删落盘目录**；只改库不删目录，模型照样看得见（目录才是它的权限边界）。
- `SKILL.md` 由「description + frontmatter + 正文」拼出来；frontmatter 不进块编辑器。
- 写链路：校验（Mastra `validateSkillContent`，收在 `core/skills/skill.content.ts`）→ 事务写库（乐观锁
  `expectedVersion`，冲突 3417）→ 落盘 → `loader.reload()`。落盘失败报 3418，重启自愈。
- **链接导入**：`skill.source.ts`（`parse-github-url` 解析 + skills.sh 映射）→ `skill.remote.ts`
  （`@octokit/rest` 取 `git/trees/HEAD?recursive=1`，文件走 raw，失败回落 contents）。
  skills.sh 的公开 API 要 Vercel OIDC（实测 401），**不能用**；第三方 well-known 来源（`/site/...`）不支持。
- 编辑器在路由组 `(canvas)`（全窗口画布，URL 仍是 `/main/ai/skills/[skillKey]`）；
  列表页在管理台外壳里。新建只填名称，description 落 `SKILL_DESCRIPTION_PLACEHOLDER`。

## 坑

- `pnpm db:gen` 生成的迁移用 **value import**（`import { MigrationInterface }`），ESM 下跑不起来：
  改成 `import type`，类名不能以数字开头（`AiSkillLibrary1794325439344`）。
- `core/**` 新增 `@mastra` 引用会被 `pnpm check:mastra` 拦（允许清单只减不增）。技能校验的 Mastra 引用
  统一走 `skill.content.ts`（清单里替换掉原来的 loader 一行）。
- GitHub **整仓 tarball 不可行**：`anthropics/skills` 压缩包实测 90s 下不完；用 API 文件树（~170KB、8s）
  + raw 按需取文件。`git/trees/HEAD` 可直接用，省掉查默认分支的调用。未认证限额 60 次/时/IP。
- `tar` 包的 `onentry` 是废弃别名（不会注册回调）；真要流式解包得用 `onReadEntry` **并 resume**，
  否则解析器卡在条目上。当前方案已不用 tar。
- admin 文件查询的缓存刷新要**区分是否文件真的变了**：保存元信息时刷新文件列表会把未保存的代码草稿冲掉。
- `file/read` 返回的是**整份 SKILL.md（含 frontmatter）**，块编辑器必须先 strip frontmatter ——
  否则开头的 `---` 会被 Markdown 解析成 setext 标题，页面上会看到 `name:` / `description:` 伪内容。
- 删除 `main/ai/skills/[skillKey]` 后 `.next/types` 还引用旧路由，typecheck 会报 module not found：删 `.next/types` 再跑。

## 依据

- `docs/design/ai-skill-library.md`（完整方案）
- `apps/server/src/modules/ai/core/skills/{skill.loader,skill.materializer,skill.draft,skill.paths,skill.content}.ts`
- `apps/server/src/modules/ai/skills/{skill.service,skill.repository,skill.source,skill.remote,skill.tools}.ts`
- `apps/server/test/ai-skill-library.test.ts`、`apps/server/test/ai-skill-source.test.ts`
- 核对命令：`pnpm --filter @app/server exec vitest run test/ai-skill-library.test.ts test/ai-skill-source.test.ts`；
  `PGPASSWORD=pg1234 psql -h localhost -U root -d billy-cli -c '\d ai_skills'`（本机口径）

## 失效信号

- 换掉 Mastra 的技能加载机制 / 改成内存内联技能；
- `skillsLibraryDir` 默认值或 loader 的扫描顺序变了；
- skills.sh 开放了免鉴权的详情 API（那时可以直接用它，省掉 GitHub 折算）；
- 多实例部署（落盘只在处理写请求的实例上发生，别的实例要重启才同步 —— 与 AI memory 在进程内同类）。
