# AI 扩展指南：加工具 / 加技能 / 加连接器

> 面向"要给这个 agent 加一种能力"的人。三条路径互不替代：
> **工具** = 代码写死的能力；**技能** = 教模型怎么用的文档；**连接器** = 后台配置的外部能力来源。
> 设计依据见 [`ai-agent-tool-engine.md`](./ai-agent-tool-engine.md)、[`ai-connector.md`](./ai-connector.md)；
> agent 侧的开发规范见 skill `develop-ai-agent`（`references/extension.md`）。

## 0. 先判断该走哪条

| 你要加的东西 | 走哪条 | 要不要改代码 |
| --- | --- | --- |
| 一个只有我们平台才有的动作（发通知、写业务表、内部 RPC） | 工具 | 要 |
| 教模型"在某个场景下按什么步骤做"（命令用法、评审清单、排查流程） | 技能 | 只写 Markdown |
| 接一个外部系统（数据库 / 第三方接口 / 厂商 MCP / 命令行工具） | 连接器 | 接现成型号不用；加新型号要 |

---

## 1. 加一个工具

**位置**：`apps/server/src/modules/ai/tools/**`（具体工具）+ `core/tools/tool-keys.ts`（key 登记）。
现有工具组（一个组 = 一个类，组内一个 `@ToolDecl` 方法一个工具）：`tools/planner/planner.tools.ts`
（4 个计划工具）、`tools/bash.tool.ts`、`tools/subagent.tool.ts`、`tools/read-tool-result.tool.ts`、
`tools/web.tools.ts`（联网三件套，底层在 `tools/web/`：抓取 / 分页 / 搜索）、
`skills/skill.tools.ts`（7 个技能工具）、`files/file.tools.ts`（9 个文件工具）。

五步：

1. **登记 key**：在 `core/tools/tool-keys.ts` 的 `TOOL_KEYS` 加一项（不写裸字符串，改名时编译期报错）；
2. **写工具组**：`@Injectable()` 类 + 类上 `@ToolGroup({ category, scope, child })`；
   依赖（service / 仓储）全部构造器 `@Inject`；
3. **写方法 + `@ToolDecl`**：一个方法 = 一个工具；
   `params` / `config` 用**同文件模块级 zod 常量**（装饰器在类定义期求值），`config` 每个字段 `.default()`；
   `description` 只写"是什么 / 什么时候用 / 什么时候不用"，**参数机制写进 `.describe()`**；
4. **装配**：新组要在 `ai.module.ts` 的 `AGENT_TOOL_GROUPS` 工厂（`inject` + `useFactory` 参数）
   与 `providers` 里各加一行；目前登记了 **7 个组**：`PlannerTools` / `BashTool` / `RunSubAgentTool` /
   `ReadToolResultTool` / `WebTools` / `SkillTools` / `FileTools`。
   授权写 `agents/assistant.agent.ts` 的 `tools`，四种选择器可用：具体 key、`ALL_TOOLS`（`'*'`，
   展开成注册机里全部工具）、`{ category }`、`{ connector, tool? }`（见 `core/tools/tool-selector.ts`）；
5. **测试**：`test/ai-tools/<key>.test.ts`，用 `specByKey(...)` 或 `buildToolSpecs(group)` 直接调 `exec`；
   跑 `pnpm --filter @app/server test test/ai-tools-battery.test.ts`（会检查说明长度 60–380 字符等）。

三条容易忘的：

- 执行体**只写业务动作**：开关、作用域、限额、分页、脱敏、审计都在网关插件里；
- 需要秘钥就在声明里写 `secrets` + `secretFields`（网关的 precheck / redact 认它）；
- 子 agent 不能用的标 `child: 'deny'`，委派类标 `delegation: true`。

---

## 2. 加一个技能

先说清**两种技能**，别混：

| 用途 | 放哪 | 谁读 |
| --- | --- | --- |
| 给**写代码的 agent** 看的工程规范 | 仓库 `.agents/skills/<name>/SKILL.md` | Claude Code / DSH 等编码 agent |
| 给**运行时助手**用的业务技能 | `core/skills/catalog/<name>/`（随包）、`AGENT_SKILLS_DIRS` 指向的目录，或**后台技能库**（`ai_skills` + `ai_skill_files`，落盘到 `AGENT_SKILLS_LIBRARY_DIR`，默认 `~/.billy/skills`） | `SkillLoader` → Mastra → 助手 |

### 2.1 仓库开发技能（工程规范）

按 `manage-skills` skill 走：目录 + frontmatter（`name` / `description` / 触发词）→ 主文件超 60 行拆
`references/` → 登记到 `billy-dev-foundation/references/catalog.md` 与 `.agents/skills/README.md`。

### 2.2 运行时助手技能（教模型怎么做事）

1. **放目录**：`apps/server/src/modules/ai/core/skills/catalog/<name>/SKILL.md`
   （随包、**严格校验**，坏一个启动失败）；或放到 `AGENT_SKILLS_DIRS` 配的目录（默认 `~/.agents/skills`，
   坏一个只跳过并记 `ai.skills.invalid`）。
   > 内置技能目前有 `catalog/html-page`（写 HTML 页面：单文件 + CDN 三级兜底）；再加一个就是建一个目录 + `SKILL.md`。
2. **写 frontmatter**：`name`（唯一，缺省用目录名）+ `description`（对象 + 什么时候用 + 触发词，
   **不要超过 1024 字符**，超了会被当成坏技能跳过）。正文写步骤、示例、坑；长内容放 `references/`。
3. **授权**：agent 声明里 `skills: [ALL_SKILLS]`（默认，全部已加载技能）或写具名数组（写了不存在的名字启动即失败）。
4. **验证**：启动日志 `ai.skills.loaded` 看数量和名字；重名会记 `ai.skills.duplicate`（**先扫到的赢**，
   catalog 优先于技能库、技能库优先于外部目录）；对话里说"你有哪些技能"应能列出。

注意（2026-11-13 现状）：

- 扫描顺序是 `catalog/` → **技能库落盘目录** → `AGENT_SKILLS_DIRS`，结果进程内缓存；
- **通过后台 / `skill-*` 工具增删技能不用重启**（写链路末尾会 `SkillLoader.reload()`）；
  **手工往外部目录里加目录要重启**（或等有写操作触发 reload）；
- 技能的**正文**由 Mastra 按需读盘（改了不用重启）。

---

## 3. 加一个连接器

### 3.1 只加一条实例（不改代码，最常见）

后台「AI → 连接器」→ 新建 → 选型号（PostgreSQL / MySQL / Redis / 飞书 CLI）→ 填地址与账号 →
**测试**（只验证连通）→ **同步**（把工具登记进 `ai_tools`）→ 新开一轮对话即可用。

等价接口：`/ai-connector/create` → `/ai-connector/test` → `/ai-connector/sync`。

### 3.2 加一种新型号 / 新驱动（要改代码）

现有驱动只有三个（一个驱动可以服务多个 catalog 型号）：
`drivers/sql.driver.ts`（`kind='sql'`，服务 PostgreSQL / MySQL 两个型号）、
`drivers/redis.driver.ts`（`kind='redis'`）、
`drivers/lark-cli.driver.ts`（`kind='lark-cli'`，命令型，含 `lark-cli.policy.ts` / `lark-cli.home.ts`）。

以"再加一个数据库类型"为例，四处：

1. **目录条目**：`connectors/connector.catalog.ts` 加一条 `ConnectorCatalogDecl`：
   `kind` / `name` / `description` / `driver` / `transport` / `fields`（表单字段声明，
   `secret: true` 的进 `secrets`）/ **`defaults`**。
   `defaults` 必须写：`dialect`、默认端口这类"用户不填但决定连谁"的字段——
   漏了会出「选了 MySQL 却用 PG 协议连 3306」的事故（`received invalid response: 4a`）。
2. **驱动实现**：`connectors/drivers/<name>.driver.ts`，实现 `describe()`（能力清单）/
   `invoke()`（调用）/ `probe()`（探活），需要回收就加 `dispose()`；
   `auth` 声明基础层与主体层；`secretFields` 决定表单与脱敏。
   新驱动 **不许 import `@mastra/*`**（`pnpm check:mastra` 守）。
3. **装配**：`ai.module.ts` 的 `providers` 加驱动，并在 `CONNECTOR_DRIVERS` 工厂里加一行
   `[driver.kind, driver]`。
4. **测试**：`test/ai-connector.test.ts` 补该型号的 `defaults` 断言；驱动逻辑（只读判定 / 命令白名单 /
   错误分类）优先写成**纯函数**再测，别只靠联调。

**命令行型驱动的额外口径**（样板：`drivers/lark-cli.driver.ts` + `drivers/lark-cli.policy.ts`）：

- 能力面只出**一个受限 `run`**（参数数组），用 `spawn` / `execFile` 直传，**不要走 shell**、不要把整条命令串交给模型；
- 命令白名单写死在 `*.policy.ts` 的纯函数里（页面改不了），拒绝 `--profile` / `--yes` 与一切管理命令；
- 每个实例一个独立 `HOME`（`~/.billy/lark-cli/<实例 id>`，容器里是 `/home/appuser/.billy/lark-cli/<id>`），
  凭证写进该目录的 CLI 配置，子进程环境变量走白名单（不带服务端密钥），`cwd` 固定在实例目录；
- **pod 无状态**（2026-11-13 现状）：HOME 只是临时目录，配置 / 用户 token 在调用前从
  `ai_connectors.auth_state` 恢复、调用后在**实例级 Redis 锁**里 diff 写回
  （`lark-cli.home.ts` 的 `snapshotHome` / `restoreHome`，单文件 ≤256KB、总量 ≤2MB，
  跳过 `cache` / `tmp` / `logs`）；hydrate 失败时**不写回**，免得拿空 HOME 覆盖库里的授权；
- CLI 二进制由**镜像预装**（`docker/Dockerfile.server`），驱动不做运行期安装；
  没装时返回 `precheck-failed` 并给"镜像已装 / 本地怎么装"的提示；
- 若 CLI 自带技能文档，优先让模型用它的 `skills list/read` 读（省系统提示词），
  不要把几十份 `SKILL.md` 一股脑塞进 `AGENTS_SKILLS_DIRS`。

四条与现有实现绑定的口径：

- 工具 key 是 `c-<实例 key>-<远端名>`（≤64），**追溯只认 `ai_tools.connector_id`**，不做字符串反解；
- 连接器工具默认 `scope='admin'`（数据库这类能力默认只给管理员对话），要放开在 `/ai-tool/*` 改；
- 密钥在**实例**上，不在 `ai_tools`；`connector-guard` 每次调用把实例密钥嫁接进工具设置，
  precheck 与脱敏才都正常（否则会误报"缺少密码"）；
- 驱动抛的异常由工具工厂统一翻成 `upstream`（外部服务不可用）；只有 `ToolDeniedError` 会原样透传
  （例如只读 SQL 被拒 → `invalid-input`）。

### 3.3 验证清单

1. 后台新建 → 状态「未验证」；
2. 「测试」→ 状态「可用」；改错端口再测 → 状态「不可用」且最近错误有原文；
3. 「同步」→ 工具数 > 0，`ai_tools` 里能看到 `origin=connector` 的行；
4. 新开对话让模型调一次，时间线里能看到工具调用与结果；
5. 关掉实例 → 再调返回「连接器已停用」（`disabled`）；
6. 用一个**只读**查询验证权限；写语句应返回 `invalid-input`。

---

## 4. 相关文件

| 主题 | 文件 |
| --- | --- |
| 工具 key 登记 | `core/tools/tool-keys.ts`（`TOOL_KEYS` + 运行期自带 `RUNTIME_TOOLS`） |
| 工具 DSL / 注册机 / 网关 / 选择器 | `core/tools/**`（`tool.decorator.ts` / `tool.registry.ts` / `tool.gateway.ts` / `tool-selector.ts`）、`docs/design/ai-agent-tool-engine.md` |
| 具体工具 | `tools/**`（`bash` / `web` / `planner` / `subagent` / `read-tool-result`）、`skills/skill.tools.ts`、`files/file.tools.ts` |
| 工具装配 | `ai.module.ts` 的 `AGENT_TOOL_GROUPS` 与 `providers` |
| 提示词模板 | `core/prompts/templates/**`（`assistant.eta` + `partials/`） |
| 技能加载 | `core/skills/skill.loader.ts`、`core/skills/skills.types.ts` |
| 技能库（DB + 落盘） | `core/skills/skill.materializer.ts`、`skills/skill.service.ts`、后台 `/main/ai/skills` |
| 连接器 | `connectors/**`（`connector.catalog.ts` / `drivers/`）、`docs/design/ai-connector.md`、后台 `/main/ai/connectors` |
| agent 声明 | `agents/*.agent.ts`、`agents/index.ts` |
| skill 开发规范 | `.agents/skills/develop-ai-agent/references/extension.md` |
| skill 创建/维护 | `.agents/skills/manage-skills/` |

### 4.1 验收命令

```bash
# 工具：注册机标准测试集（说明长度 60–380、默认值齐全、模板齐全）
pnpm --filter @app/server test test/ai-tools-battery.test.ts

# 技能：库 / 链接解析 / 加载器
pnpm --filter @app/server exec vitest run test/ai-skill-library.test.ts test/ai-skill-source.test.ts test/ai-skills-loader.test.ts

# 连接器：catalog 默认值与驱动纯函数
pnpm --filter @app/server test test/ai-connector.test.ts

# 结构与边界
pnpm typecheck && pnpm check:ui && pnpm check:inject && pnpm check:mastra
```

注意：`check:mastra` 的两条边界是 `core/tools/**` 与 `tools/**`（禁止 import `@mastra/*`），
`mastra/**` 豁免；其余文件靠**只减不增**的允许清单（`scripts/check-mastra-boundary.ts` 的
`MASTRA_ALLOWLIST`，值是 import 条数）兜住。技能校验的 Mastra 引用统一走 `core/skills/skill.content.ts`
（它在清单里占用一条）。
