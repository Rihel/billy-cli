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

五步：

1. **登记 key**：在 `core/tools/tool-keys.ts` 的 `TOOL_KEYS` 加一项（不写裸字符串，改名时编译期报错）；
2. **写工具组**：`@Injectable()` 类 + 类上 `@ToolGroup({ category, scope, child })`；
   依赖（service / 仓储）全部构造器 `@Inject`；
3. **写方法 + `@ToolDecl`**：一个方法 = 一个工具；
   `params` / `config` 用**同文件模块级 zod 常量**（装饰器在类定义期求值），`config` 每个字段 `.default()`；
   `description` 只写"是什么 / 什么时候用 / 什么时候不用"，**参数机制写进 `.describe()`**；
4. **装配**：新组要在 `ai.module.ts` 的 `AGENT_TOOL_GROUPS` 工厂与 `providers` 各加一行；
   要授权给 agent 就在 `agents/assistant.agent.ts` 的 `tools` 里加 key（`ALL_TOOLS` 已覆盖连接器工具）；
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
| 给**运行时助手**用的业务技能 | `core/skills/catalog/<name>/`（随包）或 `AGENT_SKILLS_DIRS` 指向的目录 | `SkillLoader` → Mastra → 助手 |

### 2.1 仓库开发技能（工程规范）

按 `manage-skills` skill 走：目录 + frontmatter（`name` / `description` / 触发词）→ 主文件超 60 行拆
`references/` → 登记到 `billy-dev-foundation/references/catalog.md` 与 `.agents/skills/README.md`。

### 2.2 运行时助手技能（教模型怎么做事）

1. **放目录**：`apps/server/src/modules/ai/core/skills/catalog/<name>/SKILL.md`
   （随包、**严格校验**，坏一个启动失败）；或放到 `AGENT_SKILLS_DIRS` 配的目录（默认 `~/.agents/skills`，
   坏一个只跳过并记 `ai.skills.invalid`）。
   > 当前仓库里 `core/skills/catalog/` **还不存在**（默认只加载 `~/.agents/skills`）；要随包发技能就先建这个目录。
2. **写 frontmatter**：`name`（唯一，缺省用目录名）+ `description`（对象 + 什么时候用 + 触发词，
   **不要超过 1024 字符**，超了会被当成坏技能跳过）。正文写步骤、示例、坑；长内容放 `references/`。
3. **授权**：agent 声明里 `skills: [ALL_SKILLS]`（默认，全部已加载技能）或写具名数组（写了不存在的名字启动即失败）。
4. **验证**：启动日志 `ai.skills.loaded` 看数量和名字；重名会记 `ai.skills.duplicate`（**先扫到的赢**，
   catalog 优先于用户目录）；对话里说"你有哪些技能"应能列出。

注意：技能清单在启动时扫一次并缓存（增删要重启）；技能的**正文**由 Mastra 按需读盘（改了不用重启）。

---

## 3. 加一个连接器

### 3.1 只加一条实例（不改代码，最常见）

后台「AI → 连接器」→ 新建 → 选型号（PostgreSQL / MySQL / Redis / 飞书 CLI）→ 填地址与账号 →
**测试**（只验证连通）→ **同步**（把工具登记进 `ai_tools`）→ 新开一轮对话即可用。

等价接口：`/ai-connector/create` → `/ai-connector/test` → `/ai-connector/sync`。

### 3.2 加一种新型号 / 新驱动（要改代码）

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
- 每个实例一个独立 `HOME`（如 `~/.billy/<driver>/<实例 id>`），凭证写进该目录的 CLI 配置，
  子进程环境变量走白名单（不带服务端密钥），`cwd` 固定在实例目录；
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
| 工具 DSL / 注册机 / 网关 / 配置 | `core/tools/**`、`tools/**`、`docs/design/ai-agent-tool-engine.md` |
| 提示词模板 | `core/prompts/templates/**`（`assistant.eta` + `partials/`） |
| 技能加载 | `core/skills/skill.loader.ts`、`core/skills/skills.types.ts` |
| 连接器 | `connectors/**`、`docs/design/ai-connector.md`、后台 `/main/ai/connectors` |
| agent 声明 | `agents/*.agent.ts`、`agents/index.ts` |
| skill 开发规范 | `.agents/skills/develop-ai-agent/references/extension.md` |
| skill 创建/维护 | `.agents/skills/manage-skills/` |
