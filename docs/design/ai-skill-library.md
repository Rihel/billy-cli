# AI 技能库（在线编辑 + 链接导入 + 启停治理）

> 状态：已落地（2026-11-10，2026-11-11 改为链接导入 + 沉浸式编辑器）
> 关联：`docs/design/ai-agent.md` §1.4（技能发现 / 校验 / 授权）、`ai-agent-tool-engine.md` §5.5（配置类数据的口径）

## 1. 问题与现状

### 1.1 现状

- 技能只以**磁盘目录**的形式存在：随部署打包的 `core/skills/catalog/`（当前为空）+
  `AgentConfig.skillsDirs`（默认 `~/.agents/skills`）。
- `SkillLoader` 只做三件事：扫目录、启动期校验、按名字给出目录绝对路径；正文与 `references/`
  交给 Mastra 按需读盘。
- 想加一个技能只能：登服务器 → 建目录 → 写 `SKILL.md` → 重启服务。
- 没有"这个技能是否启用"的概念：进了目录就等于进了模型的能力面。

### 1.2 要解决的四件事

1. **在线建 skill**：在后台用类 Notion 的块编辑器写 `SKILL.md` 正文与 `references/`；
2. **从链接安装**：贴 skills.sh 技能页 / GitHub 仓库、目录、文件链接，**下载内容写入库**
   （不是登记链接、也不要求服务端能读到某个本地目录）；
3. **管理启用与使用**：总开关、按名字授权（沿用 agent 声明）、启停立即生效；
4. **agent 能定义 skill 并入库**：给主 agent 一组 `skill-*` 工具。

### 1.3 核心矛盾

**Mastra 只认磁盘目录，而"库"要能在后台编辑、下载安装与启停。**
所以必须有一层「DB 是事实源 → 落盘成 Mastra 可读的目录」的同步，而不是把 DB 当第二份真相。

## 2. 设计

### 2.1 数据模型（DB 是事实源）

两张表（`apps/server/src/database/entities/`）：

| 表 | 一行是什么 | 关键列 |
| --- | --- | --- |
| `ai_skills` | 一个技能 | `skill_key`（= 目录名，唯一）、`title`、`description`（frontmatter 的 description）、`frontmatter`（其余 YAML 键）、`enabled`、`source`、`origin_url`、`version`、`file_count`、`content_hash`、`last_materialized_at` |
| `ai_skill_files` | 技能里的一个文件 | `skill_id`、`path`（相对技能目录）、`content`、`size`、`sha256` |

口径：

- **`skill_key` 创建后不可改**（目录名就是它）：改名 = 新建 + 删除，避免"引用着旧名字的历史运行"找不到东西；
- `version` 每次内容变更 +1，用于**乐观锁**（保存时带 `expectedVersion`，不匹配就 409，防两个页面互相覆盖）；
- `frontmatter` 只存 `name` / `description` 之外的键（如 `license`、`compatibility`、`metadata`），
  渲染 `SKILL.md` 时与 `skill_key` / `description` 一起拼回 YAML；
- `origin_url` 记录"从哪个链接装来的"，便于重装 / 追溯（在线创建的为空）；
- 文件内容进库（文本），单文件与总量有上限（见 §2.5），二进制/超大文件不收。

### 2.2 落盘（materializer）

`core/skills/skill.materializer.ts`：

- 根目录 = `AgentConfig.skillsLibraryDir`（默认 `~/.billy/skills`，可用 `AGENT_SKILLS_LIBRARY_DIR` 覆盖）；
- `sync(skill)`：把该技能的**全部文件**写到 `<root>/<skill_key>/`，并删掉本次不在集合里的旧文件
  （库是这几张表的唯一拥有者，目录整体由我们管理）；
- `remove(skillKey)`：删除整个技能目录；
- `syncAll()`：启动时把**全部已启用**技能写一遍，并清掉 DB 里不存在的目录（重启不丢、停用不残留）；
- 所有路径先过 `skill.paths.ts` 的 `normalizeSkillFilePath`：拒绝绝对路径、`..`、反斜杠、空段、
  非法字符、超长；落盘时再 `resolve` 一次并校验仍在技能目录内（纵深防御）。

**为什么不是"读 DB 直接喂 Mastra"**：Mastra 的 `LocalSkillSource` 只认路径，正文与 `references/`
按需读盘；内联成 `createSkill()` 会把几十个技能全读进内存，还丢掉 `scripts/` 的懒读。

### 2.3 加载与生效

- `SkillLoader` 的扫描根变成：`catalog/`（严格）→ **技能库目录**（坏一个跳过）→
  `skillsDirs`（外部目录）；
- 任何一次写后（创建 / 保存文件 / 启停 / 删除 / 导入）→ 落盘 → `SkillLoader.reload()` 清缓存；
- agent 声明里的 `skills: [ALL_SKILLS]` **不再在装配期展开**：`SkillLoader.resolve('*')` 在**每次运行组装信封时**
  展开成当时的清单 → 新建的技能不用重启就能被授权到；
  `/agent/list` 展示时同样现算，`request_snapshot.skillKeys` 记的是**这一轮实际拿到的**名字；
- 停用 = 从库里标记 `enabled=false` + **删掉落盘目录**：Mastra 的清单与 `skill_read` 都看不到它。
- **多实例限制（如实记录）**：落盘发生在处理写请求的那个实例上，别的实例要等下次启动 `syncAll` 才看到新内容；
  与当前「AI memory / SSE 流在进程内」是同一类限制，不假装跨实例一致（单实例是当前的部署常态）。

### 2.4 接口（后台管理员）

`/ai-skill/*`（全部 POST + `AdminAuthGuard`）：

| 路由 | 作用 |
| --- | --- |
| `list` | 分页 + 关键字 / 启用 / 来源筛选 |
| `detail` | 元信息 + 文件清单（**不含正文**，避免详情接口被大文件拖慢） |
| `create` | 建技能（**只要求名称**；description 省略时落占位，见 §2.7） |
| `update` | 改元信息与开关（带 `expectedVersion`） |
| `remove` | 软删技能 + 删落盘目录 |
| `file/read` | 读单个文件正文 |
| `file/save` | 写单个文件（新建或覆盖；带 `expectedVersion`） |
| `file/remove` | 删单个文件（`SKILL.md` 不允许删） |
| `import/preview` | 解析链接：列出里面有哪些技能、哪些已存在 |
| `import` | 下载勾选的技能并写入库（可覆盖同名） |

**校验**：保存 `SKILL.md` 前用 Mastra 的 `validateSkillContent` 校验（名字 / description 长度 /
正文警告），并把 frontmatter 拼回后整体校验；不合法直接 3413，不写库、不落盘。

### 2.5 链接导入（skills.sh / GitHub）

用户给的是**技能页面链接**，不是本地目录。服务端负责"下载 → 校验 → 入库 → 落盘"：

| 链接形态 | 处理 |
| --- | --- |
| `https://skills.sh/<owner>/<repo>/<slug>` | 解析成 GitHub `owner/repo` + slug，按仓库找目录 |
| `https://github.com/<owner>/<repo>[/tree/<ref>/<path>]` | 仓库 / 目录；整仓导入时逐个技能报告 |
| `https://github.com/<owner>/<repo>/blob/<ref>/.../SKILL.md` | 定位到该技能目录 |
| `https://raw.githubusercontent.com/...` | 同上（按 ref + 路径） |
| `owner/repo[/slug]` | 简写 |
| 其它站点的 `*.md` | 单文件技能（只有 `SKILL.md`） |

实现选择：

- **`parse-github-url`** 解析 GitHub 形态（owner / repo / ref / filepath 这些边界比手写正则可靠）；
  skills.sh 与简写只是补一层映射 —— skills.sh 的技能本来就托管在 GitHub。
- **`@octokit/rest`** 调 GitHub API（官方 SDK：树、contents、限额与错误码都交给它）。
  `GET /git/trees/{ref}?recursive=1` 一次拿到文件树，文件内容优先走 `raw.githubusercontent.com`
  （不占 API 限额），失败再回落 `contents`。
- **为什么不用整仓 tarball**：大仓库（如 `anthropics/skills`）压缩包几 MB，实测这台机器 90s 都下不完；
  而文件树只有 ~170KB、秒级返回，按需再取文件更快也更省。
- **skills.sh 的公开 API 要 Vercel OIDC**（实测 401），所以不依赖它；第三方 well-known 来源
  （`/site/<domain>/...`）无 GitHub 仓库可折，明确报"暂不支持"。
- 未认证 GitHub API 限额 60 次/时/IP：管理员低频操作可接受；可配 `GITHUB_TOKEN` 提高上限。
- **限额与白名单**：只收 `SKILL.md` + `references/` `scripts/` `assets/` 下的文本文件（扩展名白名单 +
  无 NUL 字节），跳符号链接 / 二进制；单文件 200k 字符、单技能 800k 字符、100 个文件；一次最多 25 个技能。
- **两段式**：先 `import/preview` 给出"有哪些技能、哪些已存在"，用户勾选后再 `import`；
  一个坏技能只影响它自己（逐条报告 `created/updated/skipped/failed`）。

### 2.6 与 agent 的接口（工具）

`skill-list` / `skill-save`（建或改 + 可带文件）/ `skill-import`（按链接装）/ `skill-delete` / `skill-enable`：

- 一组粗粒度工具，而不是"每列一个工具"：模型一次调用就能把一个技能写完（正文 + 参考文件）；
- 复用同一套 service 校验与落盘，**agent 写入与页面写入是同一条链路**；
- 作用域 `admin`、`child: allow`（子 agent 也能维护技能，但继承父的授权面）。

### 2.7 前端（admin）

列表页留在管理台外壳里；**编辑器是独立的"全窗口画布"**（路由组 `(canvas)`，URL 不变）：

- `/main/ai/skills`：列表（名称 / 描述 / 来源 / 文件数 / 启停 / 更新时间）+ 新建 + 从链接导入 + 删除；
- **新建只填名称**（一个输入框，回车即建），建完直接进编辑器；description 先落占位
  （Mastra 不允许空描述），编辑器里提示补一句"什么时候用"；
- `/main/ai/skills/[skillKey]`：没有管理台侧栏与页头，只有 44px 工具条 + 左侧 210px 文件窄栏 +
  居中 860px 文档画布：大标题、一句"何时用"、分隔线、块编辑器；脏了才在底部浮出「保存 · ⌘S」；
- **类 Notion 编辑器**：BlockNote（块编辑、slash 菜单、拖拽），Markdown ↔ blocks 转换在客户端做；
  `SKILL.md` 的 **frontmatter 不进编辑器**（标题 / 描述在画布顶部，其他键在"技能设置"里），
  客户端在灌入编辑器前会先 strip 掉 frontmatter（否则 `---` 会被 Markdown 解析成 setext 标题）；
  `scripts/` 等非 Markdown 文件用等宽文本编辑器；
- 保存语义：显式保存（按钮 / ⌘S）；服务端乐观锁冲突时提示"刷新后重试"。

## 3. 关键流程

### 3.1 在线保存 SKILL.md

```
页面 → POST /ai-skill/file/save { skillKey, path: 'SKILL.md', content, expectedVersion }
  → SkillService.saveFile
    → 校验版本（乐观锁）
    → buildSkillMarkdown(meta, content) → validateSkillContent
    → 事务：更新文件行 + version+1 + content_hash
    → materializer.sync(技能)  ← 失败则报错（DB 已提交，重启自愈）
    → skillLoader.reload()
```

### 3.2 从链接导入

```
页面 → POST /ai-skill/import/preview { url }
  → parseSkillSource（parse-github-url / skills.sh 映射）
  → GitHub 树（octokit）→ 找技能目录 → 取 SKILL.md 与文本文件
  → 返回 { source, skills: [{ skillKey, description, fileCount, exists }], failures }

页面勾选 → POST /ai-skill/import { url, overwrite, skillKeys }
  → 逐个：校验 frontmatter → 事务写 ai_skills + ai_skill_files（source='import', origin_url=原链接）
  → materializer.sync → reload
  → 返回 { source, items: [created / updated / skipped / failed] }
```

### 3.3 启动

```
AiModule bootstrap
  → SkillLibraryService.onApplicationBootstrap()
    → materializer.syncAll(全部 enabled 的技能)
  → 首次请求时 SkillLoader 扫描（含技能库目录）
```

## 4. 测试点

- 路径归一：`../x`、`/abs`、`a\\b`、空段、超长、非法字符一律拒绝；正常 `references/a-b_1.md` 通过；
- 落盘：sync 写全量、删旧文件、remove 不越界；`syncAll` 清掉孤儿目录；
- 草稿：frontmatter 拼装 / 解析往返；description 超 1024 被 Mastra 校验拦下；
- loader：技能库目录优先于外部目录、`reload()` 后新增技能可见、`*` 现算；
- 链接解析：skills.sh / GitHub tree / blob / raw / 简写 / 直接 Markdown / well-known 报错；
- 接口：创建 → 保存 → 停用 → 列表 → 预览 → 导入（curl）；迁移执行（`psql`）。

## 5. 取舍记录

| 选择 | 为什么 | 代价 |
| --- | --- | --- |
| DB 存正文，落盘给 Mastra | Mastra 只认目录；DB 才能在线编辑 / 启停 / 审计 | 落盘失败会短暂不一致（启动自愈） |
| 链接导入走 GitHub API + raw，不用 tarball | 大仓库 tarball 太慢；树 + 按需取文件更快更省 | 受 GitHub API 限额（可配 token） |
| skills.sh 折成 GitHub 解析 | 它的 API 要 Vercel OIDC（实测 401） | 第三方 well-known 来源暂不支持 |
| 不把 frontmatter 放进块编辑器 | Notion 编辑器对 YAML 会做 Markdown 归一化 | 额外字段要单独的表单 / JSON 编辑 |
| `*` 运行期展开而不是装配期 | 在线新建的技能要能立刻被授权到 | 每次运行多一次内存清单遍历（可忽略） |
| 技能 key 不可改名 | 历史运行 / 时间线按名字引用 | 改名 = 新建 + 删除 |
| agent 工具作用域 admin | 技能是指令，用户可写 = 持久提示词注入 | 普通用户只能看，不能建 |
| 新建只填名称 + 占位描述 | 一步进入写作，不被表单拦 | 列表里会先看到"待补充"的占位 |
