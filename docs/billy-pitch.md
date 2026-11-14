# Billy · 开箱即用的 AI 应用开发

> 本文档 = 脚手架介绍叙事（落地页完整文案）+ 竞品调研报告。
> 调研日期：2026-09-02 · 2026-10-23 复核 · 2026-11-13 按代码同步能力口径（26 内建工具 / 4 连接器 / 27 skill /
> 61 基础组件 / 48 ai-elements / 19 张表 / 13 个模块；模板清单未变）。
> 竞品的 star / 价格仍是 2026-10-23 的调研值，未在 11-13 重新抓取；数据以 GitHub 与各家官网为准。
> 文中能力以仓库当前代码为准（`apps/`、`packages/`、`.agents/skills/`），不是规划。

---

# 第一部分 · 脚手架介绍叙事

## 1. 一句话定位

**开箱即用的 AI 应用开发能力。**

不是接一个模型 API、画一个聊天框就结束：会话、流式、工具、模型、审计这套运行时已经在仓库里跑通。再往下，可观测性、设计系统、分层约束一并开箱。四个卖点按重要性排：

1. **开箱即用的 AI 应用开发能力** —— 会话、工具、模型、用量、审计都是现成模块与后台页面。
2. **可观测性** —— 日志、指标、告警、链路与 AI 运行审计，出问题不用登录服务器。
3. **高颜值** —— 一套设计 token 与 61 个基础组件，前台后台共用，`check:ui` 守住漂移。
4. **高维护性** —— 数据结构只定义一份，依赖单向，五道检查在提交前拦住走样。

## 2. 痛点：AI 把写代码的成本降了，也把工程一致性的成本放大了

模板这个词过去指文件骨架：目录建好、样例放进去、删掉业务还能跑。AI 进场之后，这个理解不够用了。真实的卡点有四个：

**① 规范进不了模型的上下文，它只能给「行业平均」的写法**

模型能写出能跑的增删改查，但它不知道你的项目里错误码集中在 3xxx 段、controller 不许放业务、schema / 实体 / 表单必须字段一致。结果是代码能跑、却要重写一遍——不是省了时间，是把重写时间往后推。

**② 仓库比上下文大，agent 只能靠 grep 猜**

它不知道 `@repo/kits` 里已经有分页、分布式锁、SSE 推送，于是再造一套；它答不上来「改这个函数会波及谁」，只能给个大概，改动范围越滚越大。

**③ 交付物变了，工程没跟上**

过去交付一份代码；现在交付「AI 下次还能接着改」的工程。仓库里没有 AI 读得懂的结构说明，每次对话都从零建立理解，同一个模块反复解释，成本反复付。

**④ 做 AI 产品的人，同样没有脚手架**

流式输出、断线续传、进程崩了继续、工具权限、审计记录、用量统计、多模型配置——每家公司都要重写一遍，多数停在 demo 层：能演示，不能上线。

> 一句话：**AI 时代缺的不是会写代码的模型，是能接住 AI 产出的工程。**

## 3. 市场现在怎么解决

四条路线，各修一段，彼此不接：

| 路线 | 代表 | 给了什么 | 缺什么 |
| --- | --- | --- | --- |
| 代码模板 | Open SaaS（约 1.6 万 star）、Ixartz（约 7400 star）、Makerkit（$349）、Gravity、ShipFast、Supastarter | 能跑的骨架 | AI 只到「根目录一份 AGENTS.md + 少量规则」，规范很浅；绑定形态（Wasp DSL、多租户 SaaS）；收费的还闭源 |
| 规范 / 工作流包 | AGENTS.md 模板、skills 规则仓库、各种 spec 流程 | 该怎么写的纪律 | 没有骨架，规范落不到代码上；模型读完仍不知道你的目录、你的 kits、你的错误码长什么样 |
| AI 应用框架 | Mastra、AI SDK、LangGraph、Dify / Coze | 造 agent 的零件（流式、工具、图、记忆） | 业务后端（鉴权、数据库、存储）要另建；权限、审计、用量、恢复自己扛 |
| 生成器 / 低代码 | Amplication、create-t3-app、JeecgBoot | 一次性产出一堆代码 | 只管生成不管演进，生成出来的没人敢改 |

行业把三件事拆开卖：**有人卖骨架，有人卖说明，有人卖零件。**

而 AI 时代这三者必须同源：规范里的每一条，要能在骨架里指到具体文件；骨架的每个能力，要有对应的 skill 告诉 AI 怎么用、什么时候用；AI 产品的每个运行时部件，要有后台页面可配、有记录可查。

只卖骨架的，AI 写出一堆「符合通用习惯、不符合你」的代码；只卖规则的，模型读完照旧自由发挥。

## 4. 为什么是 Billy：四个卖点，四组证据

四个卖点都能在仓库里点开验证，不是文案：

### ① 开箱即用的 AI 应用开发能力

- **运行时已经跑通**：`conversations` / `runs` / `timelines` 三张表；SSE 流式（`/agent/chat/stream`）与断线续传（`/agent/chat/resume`、`/agent/run/stream`）；服务重启后在跑的会话恢复；上下文到模型窗口 70% 自动压缩。
- **能力不是空壳**：29 个内建工具（计划四件套、动态子 agent、命令执行、联网三件套、大结果取页、记忆三件、技能库七件、文件九件），全部过统一网关（开关 / 作用域 / 限额 / 审计 / 分页）；另有 3 个 Mastra 运行时自带的技能读取工具（`skill` / `skill_search` / `skill_read`，不进注册机）。
- **模型与账本开箱**：供应商与模型在后台配置即生效；每轮 tokens 与步数入库，按日 rollup，按模型、按 agent 汇总，运行详情能回看输入快照与错误原文。
- **扩展点只有一层**：加工具 = `@ToolGroup` 类 + 方法 `@ToolDecl`；加 agent = `agents/xxx.agent.ts` + 注册表；加技能 = `.agents/skills/` 下的 SKILL.md；换模型 = 后台模型管理。
- **接口与页面都现成**：`/agent` 前缀一套接口，前台用户与管理员共用；后台 AI 八个页面（会话、模型、工具、技能库、记忆、文件、连接器、审计）；4 类连接器（PostgreSQL / MySQL / Redis / 飞书 CLI）；`@repo/ui` 48 个 ai-elements 可直接用。

模板只给骨架，AI 框架只给零件。Billy 给的是「能上线的最小闭环」，改提示词与工具就是你的产品。

### ② 可观测性

- **一次请求可追**：requestId 写进 ALS，日志、指标、错误都带它；pino JSON 日志（开发环境美化，生产可推 Loki）。
- **指标有环比**：Counter / Gauge / Histogram 窗口聚合，快照带环比，回答「现在多少、最近怎么走、在什么区间」。
- **告警成链**：规则命中 → 按级别分流 → 通知（文件 / 邮件 / 飞书），告警记录可回看。
- **探针分两种**：`/healthz` 只看进程，`/readyz` 探依赖；滚动更新先摘流再退出，不切断在途请求。
- **AI 也可审计**：运行列表、运行详情、子 agent 的提示词与任务、错误原文都在后台可查。
- **五个页面**：状态 / 实时 / 指标 / 日志 / 规则，排障不用登录服务器。

### ③ 高颜值

- **token 只有一份**：颜色、字体、圆角、面层定义在 `packages/ui/src/globals.css`，前台与后台共用；换品牌色只改 `--brand`。
- **组件成体系**：61 个基础组件 + 48 个 ai-elements（会话、消息、推理、工具、计划、引用、附件），DataTable / ModalForm / DrawerForm / Markdown / 存储组件开箱。
- **有设计语言，不是随手拼**：主次表达、微色阶面层、单一强调色、状态色 + 文案成对、克制动效；admin 的设计语言文档写到组件与自查清单。
- **有守卫**：`check:ui` 检查组件导出、硬编码颜色、字体接线，页面不会各写各的。

### ④ 高维护性

- **数据结构只有一份**：Zod schema 同时供入参校验、TypeORM 实体、SDK 类型、后台表单与列表，改一个字段六处生效。
- **依赖方向不可逆**：shared 不依赖业务包，kits 不引用 `apps/*`，common 不依赖业务模块，service / repository 不碰 HTTP。
- **检查在提交前**：`typecheck`、`test`、`check:inject`、`check:mastra`、`check:ui` 五道，过了才算做完。
- **AI 读到的是现状**：28 个 Agent Skills 每条规则都指向仓库真实文件，代码变了 skill 要跟着改，`manage-skills` 与检查脚本降低漂移。

| 对比项 | 模板 / 规则包 / AI 框架 | Billy |
| --- | --- | --- |
| 骨架 | 有 | 通用基座：任意业务、双前端、双体系 |
| 规范 | 停在项目根一份说明 | 28 个 skill，指向真实文件，能被检查脚本拒绝 |
| AI 运行时 | 给零件，生产问题自扛 | 会话、工具、恢复、审计、用量在同一份工程里 |
| 可观测性 | 各接一套 | 日志 / 指标 / 告警 / 探针 / AI 审计已接好 |
| 设计 | 自带一套或没有 | 一套 token + 组件库，两个前端共用，有守卫 |
| 形态 | 绑定 DSL / 多租户 SaaS / 闭源付费 | 标准 TS monorepo，免费开源 |

> 别人卖「一个能跑的起点」或「一套该怎么写的说明」。Billy 给的是**一个 AI 能按你的规范接着改、并且能上线观测的工程**。

## 5. 设计原则

1. **内容有主次**：先回答「这一页为什么存在」，再决定谁占大、谁靠上；位置 → 面积 → 字号字重 → 颜色。
2. **微色阶表达层次**：页面底 / 侧栏 / 卡片 / 磁贴按明度分档，不画结构边框、不叠投影。
3. **单一强调色**：品牌色只做品牌触点与图表主色；语义色只表达状态，不当装饰。
4. **状态可读**：颜色永远和文案成对出现，不靠单一色相传递信息。

## 6. 功能

### 6.1 开箱即用的 AI 应用开发

- **会话与运行**：`conversations` / `runs` / `timelines` 三张表；运行中进度放 Redis，跑完落 Postgres；刷新能接着看。
- **流式与续传**：`/agent/chat/stream`、`/agent/chat/resume`、`/agent/run/stream`、`/agent/run/:runId/stream`；文本、推理、工具、步骤、来源全细节推送。
- **工具面**：29 个内建工具——计划四件套（`plan-create/reorder/complete/delete`）、`run-sub-agent`、`bash`、`read-tool-result`、联网三件套（`web-search` / `web-fetch` / `web-request`）、记忆三件（`memory-save` / `memory-search` / `memory-forget`）、技能库七件（`skill-list` / `skill-save` / `skill-file-save` / `skill-file-append` / `skill-delete` / `skill-enable` / `skill-import`）、文件九件（`file-submit` / `file-download` / `file-list` / `read-file` / `file-search` / `workspace-files` / `write-file` / `replace-file` / `append-file`）；另有 Mastra 运行时自带的 `skill` / `skill_search` / `skill_read` 三个（不进注册机，后台只读展示）。统一网关负责开关、作用域、限额、事件、审计、分页。
- **运行控制**：动态子 agent（提示词由主 agent 现场写）、命令执行（开关 / 工作目录 / 时长与输出上限可配）、联网预算（统一 UA、超时、字节上限、内网拦截）。
- **多模态附件**：图片与 PDF 走对象存储，只传 key；附件 key 做归属校验，不能越权读他人文件。
- **恢复与压缩**：durable 三档可配；上下文到模型窗口 70% 触发裁剪与压缩，原文保留。
- **模型与用量**：供应商表 + 模型表后台配置；每轮 tokens 与步数入库，按日 rollup，按模型 / 按 agent 汇总。
- **审计**：运行列表、运行详情、子 run、输入快照、错误原文，后台可查。
- **前端**：`@repo/ui` 内置 48 个 ai-elements，后台会话页开箱可用。

### 6.2 可观测性

- **日志**：pino 一行 JSON，requestId / userId / adminId 自动带上；开发环境美化，生产可推 Loki。
- **指标**：Counter / Gauge / Histogram 窗口聚合与环比快照；HTTP 请求由中间件自动采 QPS 与耗时。
- **告警**：规则 + 级别 + 记录 + 通知（文件 / 邮件 / 飞书）。
- **探针**：`/healthz` 与 `/readyz`；滚动更新时先排空 SSE 再关闭。
- **页面**：状态 / 实时 / 指标 / 日志 / 规则五个监控页。

### 6.3 设计系统

- **token**：颜色、字体回退链、半径、面层收在 `@repo/ui` 的 `globals.css`，`check:ui` 与 token 测试共同守漂移。
- **组件**：61 个基础组件、48 个 ai-elements、DataTable / ModalForm / DrawerForm / Markdown / 上传与预览。
- **主题**：亮色优先，完整深色模式；两个前端各自的主题 key，互不干扰。
- **规范**：`docs/design/design-system.md` 与 `admin-design-language.md` 写清取舍与自查清单。

### 6.4 工程基座

- **分层架构，依赖方向不可逆**：controller 只做校验与转发，业务逻辑与数据访问下沉 service / repository，能力复用 `@repo/kits`。
- **双前端开箱**：Web 前台（Base UI + shadcn + Tailwind 4，Server Actions）、Admin 后台（DataTable / ModalForm / TanStack），共用一套 token。
- **全类型 SDK**：`@repo/http-client` 之上封装全类型 ServerClient。
- **能力底座 `@repo/kits`**：数据库（事务、四种分页、批量写入、软删、SQL 打印）、Redis、限流、JWT、会话、密码、对象存储、SSE、Kafka、事件总线 / PubSub、飞书、通知、遥测、调度（croner + 时间轮）、沙箱工作区。
- **13 个业务模块 / 20 张表**：`auth`、`user`、`admin`、`session`、`storage`、`stream`、`share`、`monitor`、`ai`、`ai-model`、`ai-usage`、`runtime-config`、`ops`；实体 20 个、迁移 28 个。
- **部署**：Docker multi-stage，compose 一键起依赖，附 Kubernetes 清单。

### 6.5 AI 原生开发：28 个 Agent Skills

- **必读基础（1）**：`billy-dev-foundation`
- **全链路开发（8）**：`define-data-structure`、`database`、`define-dict-enum`、`develop-business-module`、`develop-backend-api`、`develop-frontend-page`、`implement-auth`、`object-storage`
- **基础设施（9）**：`concurrency`、`kafka`、`scheduler`、`stream`、`state-machine`、`telemetry`、`notification`、`lark`、`write-tests`
- **AI 与维护（5）**：`develop-ai-agent`、`ai-agent-engineering`、`codegraph`、`git-workflow`、`manage-skills`
- **框架与构建（4）**：`getting-started`、`table-state`、`migrate-v8-to-v9`（TanStack Table v9）、`tsdown`

三条机制，回应「skill 是不是空话」：

1. **skill 是硬约束**：`billy-dev-foundation` 写明业务逻辑只在 service / repository、controller 只做 HTTP 边界、错误继承 `AppError` 且 code 在 3xxx 段、schema / dict / entity 三者一致并注册 `index.ts`。
2. **规范可被验证**：三个检查脚本（`check:inject` / `check:mastra` / `check:ui`）加 typecheck 与测试，五道全过才算做完，写错就红，不靠 AI 自我声明。
3. **按需加载**：28 个 skill 不是一次性全读，AI 按任务只加载相关几个，省 token、少冲突。

### 6.6 开箱页面

- **Admin（16 个业务页）**：控制台、监控五页、用户、管理员、个人中心、AI 会话、模型管理、工具配置、技能库、文件管理、连接器、AI 审计（另有登录页、会话详情、技能编辑器与 `/s/{token}` 分享页）。
- **Web**：落地页、竞品页、登录 / 注册 / 找回密码 / 重置密码、账户与多设备会话、Markdown 渲染示例。

## 7. 技术栈为什么这么选

> 版本口径（2026-11-13，取自各 `package.json`）：NestJS **12.4** / Next.js **16.4.6** /
> TypeScript **7.0.2** / Mastra **1.82**（`@mastra/memory` 1.41）/ AI SDK **7.0.164** /
> React **19.3.1** / Tailwind **4.3** / TypeORM **1.1** / TanStack Table **9.3** / Query **5.107**。

| 选了 | 而不是 | 理由 |
| --- | --- | --- |
| NestJS 12 + Express 5 | 手写路由 / 轻量 HTTP 框架 | 模块化 + 装饰器 DI 原生，Express 5 生态成熟，与 TypeORM 装饰器实体一致；单一组合根逐个 import 基础设施模块（`XxxModule.forRoot` 自带配置 bean，未 import 即未装配） |
| PostgreSQL | MySQL | 告警规则存 jsonb、时间用 timestamptz，半结构化数据更自然，TypeORM 对 PG 支持最成熟 |
| TypeORM | Prisma | 业务经 Repository 防腐层访问数据，service 不直接依赖 ORM，可测试、可替换；装饰器实体与依赖注入契合 |
| Next.js 16 | Vite SPA | RSC + SSR + Server Actions，前台后台同构，C 端页面可 SEO |
| Base UI + shadcn + Tailwind 4 | 纯 Radix | Base UI 由 Radix 团队打造，无样式原语配 Tailwind 4，shadcn 补齐可定制组件；token 与主题收在 `@repo/ui` |
| Mastra + AI SDK 7 | 自己写 agent 循环 | 流式、工具调用、多步执行、挂起恢复交给框架；边界（工具网关、审计、落库）留在自己手里，适配层隔离 |
| Redis + Kafka + croner | 各自为战 | 缓存 / 分布式锁 / 跨实例 SSE / 运行中进度由 Redis 承担，异步消息走 Kafka，定时任务用 croner，高频用时间轮 |

## 8. 快速开始

```bash
pnpm bootstrap    # 一键初始化：环境检查 → 依赖服务 → .env → 安装 → 迁移 → 冒烟
pnpm dev:pkgs & pnpm dev:server & pnpm dev:web   # 并行启动开发环境（web 9840）
pnpm dev:admin    # 管理后台另起（9845）
```

前置条件：Node.js ≥ 26（推荐 26.13）、pnpm ≥ 12（推荐 12.18）、Docker（可选，仅本地依赖）。

## 9. 代价与边界

- **技术栈门槛**：NestJS + TypeORM + Next.js 全家桶，团队要接受这套写法；想换框架的，模板反而是束缚。
- **skill 有维护成本**：28 个 skill 描述的是仓库现状，代码改了不同步就会误导 AI。仓库用 `manage-skills` 与检查脚本降低这个风险，但消除不了。
- **AI 运行时仍在演进**：durable、压缩、多实例下的续传都有明确取舍（见 `docs/design/ai-agent.md`），不是零成本开关。
- **免费开源不等于零成本**：省掉的是从零搭基建的时间，不是理解业务与运维的时间。

---

# 第二部分 · 竞品调研报告

## 1. 调研目标

Billy 的定位是 **开箱即用的 AI 应用开发基座**（AI 对话运行时 + 可观测性 + 设计系统 + 28 个 Agent Skills + 13 个业务模块，TypeScript 全栈 monorepo）。本报告回答：市面同类「模板 / 脚手架」有哪些，Billy 凭什么差异化；以及另一条赛道（AI 应用框架）与 Billy 是什么关系。

## 2. 筛选标准

1. **只收「模板 / 脚手架」**：clone 即用、可直接在其上改业务的前后端骨架。剔除纯技术框架（Wasp / RedwoodJS / Midway）、创建器（create-t3-app）、代码生成工具（Amplication / Shipixen）、agent 工作流（gstack）、技能包 / 规则层（ai-kit / vibe-template / nextjs-ai-native-template）、低代码平台（JeecgBoot）。
2. **AI 能力**：是否内置 AGENTS.md / CLAUDE.md / agent skills / AI 集成。
3. **star 过千**：有真实社区验证，排除 0 star 的新仓库。
4. **案例 + 维护 + issues**：是否有人真用、是否还在维护、问题是否有人处理。

> AI 应用框架（Mastra / AI SDK / LangGraph / Dify）不按模板标准筛，单列第 5 节。

## 3. 核心结论

- **海外免费侧**：Open SaaS（约 1.6 万 star，AI-ready：AGENTS.md + skills + Claude Code plugin，但绑定 Wasp 声明式 DSL、单体 SaaS 形态）、Ixartz SaaS-Boilerplate（约 7400 star，无 AI）。
- **海外收费侧**：Makerkit / Gravity / ShipFast / Supastarter 是垂直 SaaS 模板，$199–$349 闭源买断，绑定 B2B 多租户 SaaS 场景。
- **国内侧**：主流是 Vue + Java（RuoYi、yudao-cloud），前端模板（ant-design-pro、vue-vben-admin、vue-element-admin）为纯前端；有 AI 能力的，AI 要么是产品内 AIGC 功能、要么是纯前端 / 纯后端的局部 skills。
- **「有 skill」不是壁垒**：Open SaaS（免费）、Makerkit / Gravity（收费）都已内置 AGENTS.md / skills / agent。差异不在「有没有 skill」，而在 skill 与**通用 TS monorepo 分层架构**的耦合深度，以及是否可被检查。
- **又一个新的分水岭**：多数模板的 AI 只用于「帮人写这个模板」，没有把 AI 能力做成产品运行时。Billy 两者都有：28 个 skill 管「怎么写」，`modules/ai` 管「产品里的 AI 怎么跑」。
- **空白**：**「通用 TypeScript 全栈 monorepo + skills 驱动 + 业务基座 + AI 运行时」这一组合，国内外无直接对标**。Open SaaS 最接近（免费 + 全栈 + AI-ready），但绑定 Wasp DSL、单体 SaaS，且没有 AI 运行时。
- **Billy 的差异化四点**：开箱即用的 AI 应用开发能力（会话 / 工具 / 连接器 / 恢复 / 审计 / 用量，不是零件）；可观测性（日志 / 指标 / 告警 / 探针 / AI 审计已接好）；高颜值（一套 token 与组件库，有守卫）；高维护性（数据结构一份、依赖单向、五道检查）。

## 4. 竞品清单（模板 / 脚手架类）

### 4.1 海外 · 免费开源

| 竞品 | 形态 | AI 能力 | star | 维护 | 真实案例 |
| --- | --- | --- | --- | --- | --- |
| [Open SaaS](https://github.com/wasp-lang/open-saas) | Wasp 框架（React + Node + Prisma） | AI-ready：AGENTS.md + skills + Claude Code plugin | 约 1.6 万 | 活跃 | Wasp 官方 starter |
| [Ixartz SaaS-Boilerplate](https://github.com/ixartz/SaaS-Boilerplate) | Next.js 全栈 | 无 | 约 7400 | 活跃 | 未具名 |

### 4.2 海外 · 收费商业

| 竞品 | 形态 | AI 能力 | 价格 | 维护 | 真实案例 |
| --- | --- | --- | --- | --- | --- |
| [Makerkit](https://makerkit.dev) | Turborepo monorepo SaaS | AGENTS.md + 自研 MCP Server（56+ 工具） | $349 买断 | 非常活跃 | Caretrics、watchthis.page |
| [Gravity](https://usegravity.app) | 全栈 SaaS（Node + React + RN） | CLAUDE.md / AGENTS.md / IDE rules | $199 起 · 续费 $195/年 | 活跃 | 有证言（CodeTutor 等） |
| [ShipFast](https://shipfa.st) | 单体 Next.js SaaS | 仅 GPT 提示词 + OpenAI 集成（弱） | $199 起 | 更新趋缓 | 283 个 Stripe 验证项目 |
| [Supastarter](https://supastarter.dev) | Next.js / Nuxt / SvelteKit | 未查到 | $299 起 | 商业维护 | 未具名 |

### 4.3 国内 · 全栈脚手架

| 竞品 | 形态 | AI 能力 | star | 维护 | 真实案例 |
| --- | --- | --- | --- | --- | --- |
| [yudao-cloud](https://github.com/YunaiV/yudao-cloud) | Java Spring Cloud 微服务 + Vue3 | 内置 AI 大模型业务模块（LLM 对话 / 生图），非 agent 工作流 | 约 1.9 万 | 活跃 | 未具名 |
| [RuoYi](https://github.com/yangzongzhuan/RuoYi) | Java Spring Boot + Thymeleaf/jQuery | 无（仅有 DB 表生成 CRUD 的模板生成器） | 约 8500 | 活跃 | 大量二次开发 |

### 4.4 国内 · 前端模板

| 竞品 | 形态 | AI 能力 | star | 维护 | 真实案例 |
| --- | --- | --- | --- | --- | --- |
| [ant-design-pro](https://github.com/ant-design/ant-design-pro) | React + antd 前端 | CLAUDE.md + 2 个 skills（/antd、/pro-upgrade） | 约 3.9 万 | 活跃 | 蚂蚁集团出品 |
| [vue-vben-admin](https://github.com/vbenjs/vue-vben-admin) | Vue3 + TS 前端 | 无 | 约 3.3 万 | 活跃 | 未具名 |
| [vue-element-admin](https://github.com/PanJiaChen/vue-element-admin) | Vue2 前端 | 无 | 约 9 万 | 已停更 | 大量内部系统 |

## 5. 另一条赛道：AI 应用框架

这些项目不解决「业务骨架」，解决「agent 怎么跑」。它们与 Billy 的关系是：Billy 用其中一套（Mastra + AI SDK），并补上它们不管的部分。

| 项目 | 定位 | 给什么 | 不给什么 |
| --- | --- | --- | --- |
| [Mastra](https://mastra.ai) | TypeScript agent 框架 | agent / 工作流 / 工具 / 记忆 / 流式的运行时与适配 | 业务基座、鉴权、后台页面、审计与用量 |
| [AI SDK](https://ai-sdk.dev) | 模型调用与流式原语 | 统一模型接口、流式协议、UI 钩子 | 工程结构与业务能力 |
| [LangGraph](https://langchain-ai.github.io/langgraph/) | 图编排框架 | 有状态的多步编排 | TypeScript 全栈与后台管理 |
| [Dify](https://dify.ai) / Coze | 可视化 LLM 应用平台 | 低门槛搭知识库 / 工作流 / 机器人 | 可改的代码基座与后端扩展 |

Billy 的选择：**用 Mastra + AI SDK 做执行，把业务真正要守的边界留在自己手里**——工具网关（开关 / 作用域 / 限额 / 审计 / 分页）、运行落库（会话 / 运行 / 时间线）、恢复与压缩、模型与供应商配置、用量统计。适配层隔离，换框架不动业务。

## 6. 已剔除清单（非「模板 / 脚手架」类）

| 项目 | 类型 | 剔除原因 | star / 价格 |
| --- | --- | --- | --- |
| create-t3-app | 创建器（CLI） | 是「创建器」而非 clone 即用模板，且无 AI | 约 2.9 万 star |
| Wasp | 声明式全栈框架 | 纯技术框架，需学习其 DSL/编译器 | 约 1.9 万 star |
| RedwoodJS | 约定式全栈框架 | 纯技术框架，且已停更 | 约 1.8 万 star |
| Midway | Node + TS 后端框架 | 纯后端框架，非前后端一体 | 约 7700 star |
| JeecgBoot | Java + Vue 低代码平台 | 低代码平台 / 框架，非模板 | 约 4.8 万 star |
| Amplication | 后端代码生成工具 | 代码生成工具，非前后端一体 | 约 1.6 万 star |
| Shipixen | 前端落地页生成器 | 工具，纯前端、无后端 | $249/年 |
| gstack | agent 角色工作流 | 工作流层，非工程骨架 | 约 13 万 star |
| vibe-template | 规则层 / 命令注册表 | 规则层，不生成应用 | 0 star |
| ai-kit | 技能包 | 技能包，无应用骨架 | 6 star |
| nextjs-ai-native-template | 前端骨架 + 规约 | 前端骨架、无后端，且无后续提交 | 0 star |

> Mastra / AI SDK / LangGraph / Dify 单列为第 5 节的另一条赛道，不在此表。

## 7. 一句话总结

**模板卖骨架，规则包卖说明，AI 框架卖零件；Billy 把骨架、说明、AI 运行时做成同一份工程，并让规范可以被检查。**
