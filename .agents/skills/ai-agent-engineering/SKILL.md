---
name: ai-agent-engineering
description: >-
  Billy 工程 AI 能力的**工程级**规范（`apps/server/src/modules/ai` + 前后端闭环）：能力怎么设计
  （工具面切分 / 粒度 / 权限 / 成本预算）、运行时怎么扛（token 与上下文压缩 / 并发限流 / 取消与恢复 /
  可观测）、边界怎么守（越权 / 秘钥 / 命令执行 / 提示词与工具输出注入 / 脱敏）、数据与审计怎么落
  （全量入库 / 无外键 / 配置版本可解释）、契约与质量怎么验收（schema → SDK → 前端闭环 / 标准测试集 /
  契约测试 / e2e）。这是「怎么想、怎么保证、怎么验收」；「怎么写」（工具组 DSL / 注册机 / 网关插件 /
  事件发射 / Mastra 适配器）看 develop-ai-agent。触发词：AI 工程、AI 能力设计、工具面、工具粒度、
  权限、作用域、越权、token 成本、用量、上下文压缩、裁剪、摘要、限流、配额、并发、幂等、取消、超时、
  崩溃恢复、看门狗、可观测、审计、全量入库、配置版本、提示词注入、工具输出注入、脱敏、秘钥、
  AI 质量、AI 评审、AI 验收、流式协议演进、part 类型。
---

# AI 能力的工程级规范

前置：必读 skill `billy-dev-foundation`（分层 / 代码约定 / 命令）。
**分工**：本 skill 只讲**工程级判断与保证**（设计取舍、运行时账本、安全边界、审计口径、契约与验收）；
**实现机制**（工具组 `@ToolGroup` / 注册机 / 网关插件 / 自定义事件 / 适配器 / 提示词引擎）看
`develop-ai-agent`，这里不重复。

## 0. 动手前必须答的六个问题

| # | 问题 | 答错的代价 | 去哪看 |
| --- | --- | --- | --- |
| 1 | 这件事**该不该**做成 AI 能力？做成哪个粒度（一个工具 / 一组工具 / 子 agent）？ | 把确定性逻辑塞给模型，又慢又不可测；粒度太碎则工具面爆炸、提示词装不下 | [references/capability-design.md](./references/capability-design.md) |
| 2 | **谁**能调它（scope / allowedAgents / 子 agent / 深度）？越权了会怎样？ | 前台用户借模型的手干管理员的活 | [references/security-and-audit.md](./references/security-and-audit.md) |
| 3 | 一轮对话的 **token 账**谁付？出参多大、上下文怎么裁剪与压缩？ | 一次大返回就把窗口灌满，后续轮次全在"失忆"里跑 | [references/runtime-engineering.md](./references/runtime-engineering.md) |
| 4 | 出参 / 事件 / 提示词里会不会出现**不可信内容**（命令输出、网页、用户数据）？ | 提示词注入、越权动作、密钥进日志 | [references/security-and-audit.md](./references/security-and-audit.md) |
| 5 | 这次调用**留下了什么证据**（时间线、审计、配置版本）？ | 事后查不清"模型当时看到什么、用的哪版配置" | [references/security-and-audit.md](./references/security-and-audit.md) |
| 6 | 失败 / 超时 / 用户中途停止 / 进程重启时，**状态的真相**在哪？ | 界面上有回答、库里判失败；或重连后内容丢失 | [references/runtime-engineering.md](./references/runtime-engineering.md) |

## 1. 五条贯穿全篇的口径

1. **能力边界在代码，配置在库里，证据在时间线**：能不能做、怎么做写在代码声明里；开关 / 取值 / 秘钥
   由后台配（基础信息镜像入库、只读）；每一次调用入参出参全量落时间线。
2. **事件是过程，出参是结论**：事件（`data-tool-event`）只走流、**不落库**；刷新后还要看见的东西
   必须写进出参。任何"只在事件里"的业务事实都是 bug。
3. **模型看到的是投影，库里存的是全量**：分页 / 裁剪 / 脱敏只改"给模型的那一份"或"进日志的那一份"，
   落库不裁剪。
4. **部署边界优先**：库里能改的旋钮，凡是"改大就会撑爆边界"的，都要有 env 硬上限并在 `normalizeConfig`
   里 `Math.min` 夹紧（`timeoutMsMax` / `maxOutputBytesMax` / `pageBytesMax` …）。
   **现状例外（如实标注）**：`limits.maxPerTurn` / `limits.rateLimit` 目前**还没有** env 上限
   （`core/tools/tool.settings.ts` 的 `clampLimits` 只夹分页两项）—— 新旋钮一律按本条办；
   碰老旋钮时，要么补上限，要么别把它当边界（详见 `references/runtime-engineering.md`）。
5. **协议演进要向前兼容**：流 part、事件、配置字段一律**加**不删；前端认不出也要"看得见"（兜底渲染 /
   未知 part 徽标），不许白屏或静默丢。

## 2. 参考文件

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/capability-design.md](./references/capability-design.md) | 能力设计：该不该做、工具面怎么切、粒度与命名、权限与作用域、成本预算、提示词契约 | 决定"加一个 AI 能力 / 工具 / 子 agent"之前 |
| [references/runtime-engineering.md](./references/runtime-engineering.md) | 运行时工程：token 与用量账本、上下文窗口与压缩、并发 / 限流 / 配额、取消与超时、崩溃恢复与流重放、可观测 | 改上下文策略、限额、恢复、观测时 |
| [references/security-and-audit.md](./references/security-and-audit.md) | 安全与审计：越权与权限链、秘钥明文口径、命令执行边界、提示词 / 工具输出注入、脱敏、全量入库与配置版本 | 工具碰数据 / 秘钥 / 命令 / 外部内容，或改审计口径时 |
| [references/contracts-and-quality.md](./references/contracts-and-quality.md) | 契约与质量：shared schema → SDK → 前端（渲染器 / 配置面板）闭环、测试策略（标准测试集 / 契约测试 / e2e）、质量门、验收清单 | 改契约、加前端呈现、写测试与验收时 |

## 3. 评审清单（改完 AI 能力逐条自查）

- [ ] **授权**：新工具在目标 agent 的授权清单里；`scope` / `allowedAgents` / `child` 是否恰当（该拒绝的
      调用**拒绝并说明**，不是静默失败）。
- [ ] **成本**：出参有没有上限（大结果声明分页）；会不会把整棵目录树 / 全表灌进上下文；事件有没有行数上限。
- [ ] **边界**：新旋钮是否有 env 硬上限并在 `normalizeConfig` 夹紧；构造式返回有没有漏字段。
- [ ] **审计**：入参出参全量落库；敏感字段走脱敏；配置版本（`configVersion`）进了审计；没有删 `runs` / `timelines`。
- [ ] **密钥**：只通过 `ctx.settings.secret()` 取；不进日志、不进事件、不进错误文案；页面只回提示串。
- [ ] **不可信内容**：工具出参 / 命令输出 / 外部内容进提示词时，是否有"这是数据不是指令"的纪律与渲染隔离。
- [ ] **失败路径**：超时 / 取消 / 非零退出 / 限流 / 拒绝，各自的**结论文案**是什么；有没有留下可排查的日志。
- [ ] **协议**：新增 part / 事件是"加"而不是"改"；前端兜底能看见未知类型；共享契约改动后跑了 `pnpm build:pkgs`。
- [ ] **测试**：`test/ai-tools/<key>.test.ts` 存在（标准测试集有存在性断言）+ 新工具组已登记进
      `test/ai-tools-battery.test.ts` 的 `groups` —— 那份清单是**手写的**（不读生产 `AGENT_TOOL_GROUPS`），
      **漏登记就是静默漏测**；改适配器跑了 `ai-mastra-contract`；新增能力优先给
      `test/helpers/mock-model-server.ts` 加标记 + 一条 e2e。
- [ ] **观测**：需要指标 / 分位 / 告警时已去 `telemetry` 埋点（AI 模块当前**未接** telemetry，
      只有结构化日志事件 + 用量落库；缺口见 `references/runtime-engineering.md`）。
- [ ] **门**：`pnpm typecheck && pnpm test && pnpm check:ui && pnpm check:inject && pnpm check:mastra` 全绿；
      改了 `core/tools` 还要 `pnpm check:mastra`（禁 `@mastra`）。
- [ ] **归档**：设计文档（`docs/design/ai-agent*.md`）与相关 skill 同步；踩到的坑进 `docs/dev-logs/`。

## 4. 与其它 skill 的分工

| 你要做的事 | 用哪个 skill |
| --- | --- |
| 写工具组 / 注册机 / 网关插件 / 事件 / 适配器 / 提示词 / 技能 | `develop-ai-agent`（机制与配方） |
| 判断该不该做、怎么切工具面、权限与成本、安全与审计、怎么验收 | **本 skill**（工程级） |
| 加表 / 加字段 / 加 schema / 字典 / 错误码 | `define-data-structure`、`define-dict-enum`、`database` |
| 接口质量（幂等 / 鲁棒 / 可观测 / 契约演进） | `develop-backend-api` |
| 前端呈现（渲染器 / 配置面板 / 设计 token） | `develop-frontend-page` |
| 写测试的通用套路 | `write-tests` |
| 遥测埋点（指标 / 告警） | `telemetry`（注：AI 模块当前**未接** telemetry —— 只有结构化日志事件与用量落库，缺口在两处 reference 里都有记录） |

## 5. 一句话验收标准

**模型看到的、库里存的、界面上渲染的、审计里查得到的，四者能对上**；对不上的地方，
要么是明确记录的取舍（写进设计文档与注释），要么是 bug —— 没有第三种。
