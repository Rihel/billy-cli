# Billy · AI 原生全栈工程模板

> 本文档 = 脚手架介绍叙事（落地页完整文案）+ 竞品调研报告。
> 调研日期：2026-09-02 · 数据以 GitHub 为准 · star 与价格会随时间变化。

---

# 第一部分 · 脚手架介绍叙事

## 1. 一句话定位

**AI 原生工程，一套模板全栈直达。**

工程规范写进 15 个 Agent Skills，AI 开工先读规范、按你的标准交付；Hono + Next.js 16 双前端开箱即用，`pnpm bootstrap` 一键初始化。

## 2. 设计理念：把答案写进骨架

模板的职责，是把反复出现的工程难题先想清楚：接口怎么定、能力怎么复用、边界怎么划。想清楚的部分交给骨架，你只负责业务本身。

四个设计决策：

1. **规范，写进技能** —— 工程的规范，怎么分层、怎么命名、怎么交付，都写进 Agent Skills。AI 动手前先读规范，交出来的代码自然合标准。
2. **数据结构，只有一份** —— 前后端共用的数据结构只定义一份，校验、存储、表单全部共用。改一个字段，处处生效。
3. **能力，随时可换** —— 数据库、缓存、队列、存储、推送，都封装成标准接口，业务只认接口不认实现。今天用这套，明天换那套，业务一行不改。
4. **前端，拆成两套** —— 用户端重表达，管理端重效率，拆成两个应用各自用最顺手的工具；共用同一份数据结构，改一个字段两边同时生效。

价值落点：

- **对开发者**：样板交给模板，你只写业务。
- **对 AI**：交付符合规范的代码，而不是能跑的代码。
- **对架构**：分页、认证、错误、推送、监控，坑已替你踩完。

## 3. 特性

不是玩具脚手架，而是一套能直接承载真实业务的全栈工程基座。

- **分层架构，依赖方向不可逆**：Hono 只做校验与转发，业务下沉 apps/server 模块层，能力复用 @repo/kits，单向依赖、职责清晰、可测试。
- **数据结构先行**：数据结构只定义一份，后端校验、数据库、前端表单全部共用，字段永远对得上。
- **双前端开箱**：Web 前台用 Base UI + shadcn，Admin 后台用 TanStack Table / Form，统一共享 @repo/ui 组件库。
- **全类型 SDK**：在 HttpClient 之上封装全类型化 ServerClient，前端调用接口全程类型提示，杜绝魔法字符串。
- **开箱即用业务模块**：认证鉴权、用户体系、待办事项、管理员、字典枚举、对象存储、实时推送、监控告警。
- **容器化部署**：Docker multi-stage 构建，server 与 web 独立镜像，compose 一键拉起 PostgreSQL、Redis 与 MinIO。

## 4. 凭什么选 Billy

免费的有 Open SaaS、Ixartz，收费的有 Makerkit、Gravity、Supastarter。Open SaaS 同样 AI-ready，Billy 的差别在：通用 TS monorepo 而非 Wasp DSL 单体、任意业务而非单一 SaaS、免费开源而非付费垂直。

| 竞品 | 他们的做法 | Billy 的不同 |
| --- | --- | --- |
| 免费全栈模板（Open SaaS / Ixartz） | Open SaaS 同样 AI-ready（AGENTS.md + skills），但绑定 Wasp 声明式 DSL、单体 SaaS 形态；Ixartz 无 AI | 标准 TypeScript monorepo，通用工程基座：任意业务、双前端、用户 / 管理员双体系，而非单一 SaaS 产品 |
| 收费 SaaS 模板（Makerkit / Gravity / ShipFast / Supastarter） | 全栈且带 agent 规则，但绑定 B2B 多租户 SaaS 场景，闭源付费 | 免费开源、不绑定 SaaS 场景，另带监控告警、SSE、队列、对象存储等基建能力 |
| 国内脚手架（RuoYi / yudao-cloud） | Java + Vue 为主，功能全但无 AI 原生开发（AI 是产品功能或缺失） | TypeScript 全栈 + 15 个 skill 驱动，AI 按你的规范全链路交付 |

## 5. 技术栈为什么这么选

| 选了 | 而不是 | 理由 |
| --- | --- | --- |
| Hono 4 | NestJS | HTTP 层只做校验与转发，业务模块不依赖框架，薄边界可替换、可测试 |
| PostgreSQL | MySQL | 告警规则存 jsonb、时间用 timestamptz，半结构化数据更自然，TypeORM 对 PG 支持最成熟 |
| TypeORM | Prisma | 装饰器实体加 Repository，可注入、可 mock、可测试，与依赖注入天然契合 |
| Next.js 16 | Vite SPA | RSC 加 SSR 加 Server Actions，前台后台同构，C 端页面可 SEO |
| Base UI + shadcn | 纯 Radix | Base UI 由 Radix 团队打造，无样式原语配 Tailwind 4，shadcn 补齐可定制组件 |
| Redis + BullMQ + croner | 各自为战 | 缓存、分布式锁、队列、定时任务、跨实例 SSE，一套 Redis 全部扛下 |

## 6. 架构：一次请求，四层各司其职

数据流自底向上设计、自顶向下调用，每一层边界清晰。

1. **@repo/sdk 前端调用**：ServerClient 全类型化方法发起请求
2. **apps/server Hono 边界**：Zod 校验请求体，薄边界零业务
3. **apps/server/src/modules 业务核心**：Service + Repository（@repo/di 注入）
4. **@repo/kits 能力底座**：TypeORM 底座 + 分页 + 事务 + 存储 + SSE 推送

依赖方向规范：

- shared 不依赖任何业务包
- kits 不引用 apps/*
- modules 不 import Hono

## 7. AI 能力：15 个 Agent Skills

把架构规范与完整流程变成 AI 可执行的规范，AI 写的代码也能符合你的工程标准。

- **必读基础**：billy-dev-foundation
- **全链路开发**：define-data-structure、define-dict-enum、develop-business-module、develop-frontend-page、implement-auth、object-storage
- **基础设施与质量**：concurrency、queue、scheduler、stream、state-machine、write-tests、git-workflow、manage-skills

## 8. 快速开始

```
pnpm bootstrap    # 一键初始化：环境检查 → 依赖服务 → .env → 安装 → 迁移 → 冒烟
pnpm dev:pkgs & pnpm dev:server & pnpm dev:web    # 并行启动开发环境
```

前置条件：Node.js ≥ 20（推荐 24）、pnpm ≥ 11、Docker（可选，仅本地依赖）。

---

# 第二部分 · 竞品调研报告

## 1. 调研目标

Billy 的定位是 **TypeScript 全栈 monorepo + AI 原生工程模板**（15 个 Agent Skills + Hono 后端 + Web/Admin 双前端）。本报告回答：市面同类「模板 / 脚手架」有哪些，Billy 凭什么差异化。

## 2. 筛选标准

1. **只收「模板 / 脚手架」**：clone 即用、可直接在其上改业务的前后端骨架。剔除纯技术框架（Wasp / RedwoodJS / Midway）、创建器（create-t3-app）、代码生成工具（Amplication / Shipixen）、agent 工作流（gstack）、技能包 / 规则层（ai-kit / vibe-template / nextjs-ai-native-template）、低代码平台（JeecgBoot）。
2. **AI 能力**：是否内置 AGENTS.md / CLAUDE.md / agent skills / AI 集成。
3. **star 过千**：有真实社区验证，排除 0 star 的新仓库。
4. **案例 + 维护 + issues**：是否有人真用、是否还在维护、问题是否有人处理。

## 3. 核心结论

- **海外免费侧**：有 Open SaaS（约 1.6 万 star，**AI-ready：AGENTS.md + skills + Claude Code plugin**，但绑定 Wasp 声明式 DSL、单体 SaaS 形态）和 Ixartz SaaS-Boilerplate（约 7400 star，无 AI 能力）。
- **海外收费侧**：Makerkit / Gravity / ShipFast / Supastarter 是垂直 SaaS 模板，$199–$349 闭源买断，绑定 B2B 多租户 SaaS 场景。
- **国内侧**：主流是 **Vue + Java**（RuoYi、yudao-cloud），前端模板（ant-design-pro、vue-vben-admin、vue-element-admin）为纯前端；有 AI 能力的，AI 要么是产品内 AIGC 功能、要么是纯前端 / 纯后端的局部 skills。
- **「有 skill」不是壁垒**：Open SaaS（免费）、Makerkit / Gravity（收费）、gstack（工作流）都已内置 AGENTS.md / skills / agent。Billy 的差异不在「有没有 skill」，而在 skill 与**通用 TS monorepo 分层架构**的耦合，以及**通用工程基座**的形态。
- **空白**：**「通用 TypeScript 全栈 monorepo + AGENTS.md/skills 驱动 + 任意业务（非单一 SaaS）」这一组合，国内外无直接对标**——Open SaaS 最接近（免费 + 全栈 + AI-ready），但绑定 Wasp DSL、单体 SaaS 形态。
- **Billy 的差异化四点**：通用 TS monorepo（非单体、非 Wasp DSL）；通用工程基座（任意业务 + 双前端 + 用户/管理员双体系，非单一 SaaS）；免费开源（非 $199+ 闭源）；基建更全（监控告警 / SSE / 队列 / 对象存储 / 限流 / 四种分页）。

## 4. 竞品清单（模板 / 脚手架类，保留）

### 4.1 海外 · 免费开源

| 竞品 | 形态 | AI 能力 | star | 维护 | 真实案例 |
| --- | --- | --- | --- | --- | --- |
| [Open SaaS](https://github.com/wasp-lang/open-saas) | Wasp 框架（React + Node + Prisma） | AI-ready：AGENTS.md + skills + Claude Code plugin | 约 1.6 万 | 活跃 | Wasp 官方 starter |
| [Ixartz SaaS-Boilerplate](https://github.com/ixartz/SaaS-Boilerplate) | Next.js 全栈 | 无 | 约 7400 | 活跃 | 未具名 |

### 4.2 海外 · 收费商业

| 竞品 | 形态 | AI 能力 | 价格 | 维护 | 真实案例 |
| --- | --- | --- | --- | --- | --- |
| [Makerkit](https://makerkit.dev) | Turborepo monorepo SaaS | AGENTS.md + 自研 MCP Server（56+ 工具） | $349 买断 | 非常活跃 | Caretrics、watchthis.page |
| [Gravity](https://usegravity.app) | 全栈 SaaS（Node+React+RN） | CLAUDE.md / AGENTS.md / IDE rules | $199 起 · 续费 $195/年 | 活跃 | 有证言（CodeTutor 等） |
| [ShipFast](https://shipfa.st) | 单体 Next.js SaaS | 仅 GPT 提示词 + OpenAI 集成（弱） | $199 起 | 更新趋缓 | 283 个 Stripe 验证项目 |
| [Supastarter](https://supastarter.dev) | Next.js / Nuxt / SvelteKit | 未查到 | $299 起 | 商业维护 | 未具名 |

### 4.3 国内 · 全栈脚手架

| 竞品 | 形态 | AI 能力 | star | 维护 | 真实案例 |
| --- | --- | --- | --- | --- | --- |
| [yudao-cloud](https://github.com/YunaiV/yudao-cloud) | Java Spring Cloud 微服务 + Vue3 | 内置 AI 大模型业务模块（LLM 对话/生图），非 agent 工作流 | 约 1.9 万 | 活跃 | 未具名 |
| [RuoYi](https://github.com/yangzongzhuan/RuoYi) | Java Spring Boot + Thymeleaf/jQuery | 无（仅有 DB 表生成 CRUD 的模板生成器） | 约 8500 | 活跃 | 大量二次开发 |

### 4.4 国内 · 前端模板

| 竞品 | 形态 | AI 能力 | star | 维护 | 真实案例 |
| --- | --- | --- | --- | --- | --- |
| [ant-design-pro](https://github.com/ant-design/ant-design-pro) | React + antd 前端 | CLAUDE.md + 2 个 skills（/antd、/pro-upgrade） | 约 3.9 万 | 活跃 | 蚂蚁集团出品 |
| [vue-vben-admin](https://github.com/vbenjs/vue-vben-admin) | Vue3 + TS 前端 | 无 | 约 3.3 万 | 活跃 | 未具名 |
| [vue-element-admin](https://github.com/PanJiaChen/vue-element-admin) | Vue2 前端 | 无 | 约 9 万 | 已停更 | 大量内部系统 |

## 5. 已剔除清单（非「模板 / 脚手架」类）

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
