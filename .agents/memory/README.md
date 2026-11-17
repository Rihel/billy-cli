# Agent 记忆

给「开发这个仓库的 AI」用的**结论型记忆**：查过一次的东西不必再查第二次。

目的是省掉重复调查。实测一次碎调查约 20 次工具调用、每次结果上千字符；
命中一张卡片只要读几百字符。

## 和相邻资产的分工

| 位置 | 管什么 | 找法 |
| --- | --- | --- |
| `AGENTS.md` | 最高准则 | 每次对话自动读 |
| `.agents/skills/` | **该怎么做**：规范、流程、能力入口 | 按触发词加载 |
| `docs/design/` | **为什么这么设计**：方案评审稿 | 按能力名找 |
| `docs/dev-logs/` | **哪天做了什么**：时间流水 | 按日期找 |
| `.agents/memory/` | **查过才知道的结论**：坑、地图、实测数字、定过的取舍 | 先读本页索引 |

边界判据：写进记忆的是「下次动手前知道能少踩一次坑或省一轮调查」的内容。
一条规则本身该怎么执行，属于 skill；一个方案为什么长这样，属于 design。

## 用法

1. 接到任务，先读下面的索引表（约 2K 字符内），**只读命中主题的卡片**，不要全读；
   没命中就按 `AGENTS.md` 的「查证顺序」往下走（codegraph → 开发日志 → 代码），别直接翻代码；
2. 看卡片顶部的**查证优先级**，按它决定要不要现场核（级别定义在 `AGENTS.md`）；
3. 卡片里的「依据」是可核对的位置（文件:行 / 提交号 / 实测日期），拿不准就现场核；
4. 结论被推翻或前提变了，**改旧卡**，不要并排新增一张互相打脸的卡。

## 查证优先级

级别的定义与判据**以 `AGENTS.md` 的「用记忆时的查证优先级」一节为准**，本目录只管怎么标：

- 每张卡顶部标一个级别（必核 / 抽核 / 免核），索引表带「查证」列；
- 标「必核」的卡**必须附可直接跑的命令**（`grep -n` / `psql` / `ls`），写「自行核对」不算数；
- 抽核的卡在正文里写清「什么情况下要重新核」（目录、模块、依赖）；
- 免核的卡必须写明数字的日期与口径，否则降级为必核。

## 记法

收尾时只记四类：

| 类型 | 判断标准 | 反例（不要记） |
| --- | --- | --- |
| 坑 | 试错才发现的触发条件 + 正确做法 | 一眼能从代码看出的写法 |
| 地图 | 关键链路在哪个文件，省掉一轮翻找 | 目录树本身 |
| 实测 | 跑出来的数字，带日期与口径 | 估算、印象 |
| 取舍 | 当时为什么选了 A 不选 B | 还没定的待议项 |

每条必带**依据**（能核对的位置）、**失效信号**（什么情况下不再成立）、
**查证优先级**（必核 / 抽核 / 免核）。没有依据的不写；说不清失效条件说明还没想清楚；
标了必核却不写核对命令，等于让人现猜。

单张卡片控制在 40 行内。索引超过 30 条时，说明该按主题合并了。

## 索引

| 主题 | 一句话结论 | 查证 | 核对日期 |
| --- | --- | --- | --- |
| [agui-protocol](agui-protocol.md) | 输出走 AG-UI 1.0：帧 v2 event、rev 水位、快照+sinceRev、RUN_FINISHED 收尾不发 [DONE] | 必核 | 2026-11-17 |
| [ai-context-compression](ai-context-compression.md) | 摘要压缩只在轮前；轮内另有工具结果预算（prepareStep + turn-budget），落库出参不动 | 必核 | 2026-10-29 |
| [ai-agent-file-map](ai-agent-file-map.md) | AI 运行期关键链路的位置速查（上下文、时间线、记忆、技能、子 agent） | 抽核 | 2026-10-25 |
| [ai-file-management](ai-file-management.md) | `ai_files` + 9 个文件工具 + 每会话 workspace；入站引用、`uploads/`/`files/` 约定、删会话清理；HTML 预览的 CDN 白名单与「必须用 Tailwind、`<style>` 补位」口径 | 必核 | 2026-11-14 |
| [ai-command-limits](ai-command-limits.md) | bash 时长 5 分钟、模型无 timeout 入参；远端链 4 个 deadline 必须一起抬；写文件 10MB 要同时改 maxWriteBytes/maxBytes 与已入库配置 | 必核 | 2026-11-15 |
| [dev-session-log](dev-session-log.md) | 开发会话记录在 `~/.dsh/sessions/`，zstd + JSONL，可直接统计调用与用量 | 抽核 | 2026-10-25 |
| [token-cost-model](token-cost-model.md) | skill 只占工具输出 1%–3%，成本主项是「调用次数 × 累积上下文」 | 免核 | 2026-10-25 |
| [ai-subagent-card-state](ai-subagent-card-state.md) | 子助手卡状态以库里子 run 为终态权威；实时块会停在起跑快照（父流关闭 / 唤醒轮清空），历史 part 的 status 也是起跑快照 | 必核 | 2026-11-15 |
| [ai-chat-render-state](ai-chat-render-state.md) | 会话页按 part 类型增量归约成渲染单元；逐帧增量走 transient（后端不改），渲染期不再扫 parts；子 agent 过程在主区 tab 条（右栏已无该 tab） | 抽核 | 2026-11-15 |
| [ai-chat-right-panel](ai-chat-right-panel.md) | 右栏四 tab 的取数源；主区切子 agent tab 时右栏按 `activeRunId` 换作用域（系统指令/技能/任务），文件仍按根会话 | 必核 | 2026-11-15 |
| [ai-chat-route-remount](ai-chat-route-remount.md) | 会话页 `new → 真实 id` 的 replace 会重挂载页面子树，`useState` 全丢（选择类状态要存 React 之外） | 抽核 | 2026-10-27 |
| [ai-memory-module](ai-memory-module.md) | 短期 thread 落 Redis（按 token 预算、定时清理、续跑回灌）、长期 `ai_memories`；注入走 system 消息 + 快照记 ids | 抽核 | 2026-11-14 |
| [ai-skills-loading](ai-skills-loading.md) | 技能：我们只发现/校验/授权路径，正文与 references 由 Mastra 按需读；`catalog/` 现有内置 `html-page`、另加载 `~/.agents/skills`（每轮约 +11k token）；有清单 ≠ 会主动用 | 抽核 | 2026-11-12 |
| [ai-skill-library](ai-skill-library.md) | 技能库：DB 是事实源、落盘给 Mastra；链接导入走 GitHub API（skills.sh 需 OIDC）；`*` 运行期展开，停用删目录 | 必核 | 2026-11-11 |
| [ai-runtime-observability](ai-runtime-observability.md) | 首 token / 步与工具耗时都有写入点；失败按 denied / invalid / output-error 分桶；快照在调模型前落库 | 必核 | 2026-10-29 |
| [dependency-upgrade](dependency-upgrade.md) | 全量升级落点与坑：ioredis 6 与 TypeORM peer 冲突、jsdom 31 需 parse5 8.1、Table 9 新 API、AI SDK 7 usage 字段 | 抽核 | 2026-11-07 |
| [ui-components-over-native](ui-components-over-native.md) | 控件先 `@repo/ui`：已有 `DateTimePicker` / `DateRangePicker` / `Calendar`，别上原生 `input type=date`；表单用 `items[].render` 接线 | 抽核 | 2026-11-13 |
| [ui-data-table-column-id](ui-data-table-column-id.md) | DataTable 用列 id 当 key：同一 columns 数组里两列共用 `accessorKey` 会刷屏重复 key 告警 | 抽核 | 2026-11-07 |
| [ui-scrollbar](ui-scrollbar.md) | 原生滚动条伪元素不支持过渡 → 视觉由 `OverlayScrollbar` 自己画（淡入淡出、只跟随被滚容器）；Chromium 写了 `scrollbar-width`/`scrollbar-color` 会关掉 `::-webkit-scrollbar` 定制 | 抽核 | 2026-11-13 |
| [scaffold-cli-removed](scaffold-cli-removed.md) | 2026-11-09 起没有代码生成器与模板副本，新模块照现有实现手写；守卫为 check:inject / check:mastra / check:ui | 免核 | 2026-11-09 |
| [lark-cli-connector](lark-cli-connector.md) | @larksuite/cli 是下载 Go 二进制的 launcher；skills 内嵌；config 在 HOME；whoami 不能探活、doctor 才行 | 抽核 | 2026-11-09 |
| [product-facts](product-facts.md) | README / 落地页 / pitch 共用的能力数字口径（工具 26 / 连接器 4 / skill 28 / ai-elements 48 …） | 必核 | 2026-11-13 |
| [agent-tool-authorization](agent-tool-authorization.md) | agent 授权是结构化选择器；作用域装配期过滤工具面；子 agent = 父授权 ∩ 全部 − 委派 − deny，并按 caller 过滤 | 必核 | 2026-11-14 |
| [ui-dialog-escape](ui-dialog-escape.md) | Base UI Dialog 没有 `onEscapeKeyDown`：Esc 要先退全屏 / 不关窗，就在 `onOpenChange` 里看 `details.reason === 'escape-key'` 并 `details.cancel()` | 必核 | 2026-11-15 |
| [ai-subagent-result-and-wake](ai-subagent-result-and-wake.md) | 结论正文只收 `text`；wait 收口要含「已完成未消费」的子并打「已交付」标记（卡要有人补写）；`subagents/` 只给引擎写 | 必核 | 2026-11-15 |
| [security-remediation-2026-11](security-remediation-2026-11.md) | 找回密码（hash + 邮件）/ 桶私有 + 预签名 / STS 收紧 / 邮箱部分唯一 / 锁看门狗 / 工具面 caller 过滤 的落点与核对命令 | 抽核 | 2026-11-14 |
| [event-bus](event-bus.md) | kits 分三层：PubSub（传输）→ StreamHub（SSE）/ EventBus（`events:`）；at-most-once，只做失效通知 | 抽核 | 2026-11-10 |
| [model-gateway](model-gateway.md) | 内部模型网关（9992）：canonical `/v1/models/{id}/chat/completions`、协议适配器、runtime 开关与 Ollama 验证 | 抽核 | 2026-11-15 |
| [http-client-layers](http-client-layers.md) | http-client 三层（Transport / HttpClient / StreamClient）与内部 JSON 信封边界 | 抽核 | 2026-11-15 |
| [main-runtime-dedup](main-runtime-dedup.md) | main / runtime 的共享边界：横切 HTTP 在 kits、监控引擎在 @repo/monitor、静态声明只在 runtime、实体直接进 @repo/db | 抽核 | 2026-11-14 |
| [stateless-scaling](stateless-scaling.md) | 核心业务无状态可多副本；AI memory 已落 Redis，飞书 CLI 状态在 Pod 本地，工作区仍在 Pod 本地盘 | 抽核 | 2026-11-14 |
| [db-package](db-package.md) | `@repo/db` 统一实体/迁移；main / runtime 用 `DB_ENTITIES`，gateway 只注册审计实体；迁移 CLI 仍挂在 agent-runtime | 必核 | 2026-11-14 |
| [tool-metadata-authority](tool-metadata-authority.md) | 定义唯一来源 `@repo/tool-catalog`；gateway 运行时目录；worker 只报能力；`ai_tools` 只存配置 | 必核 | 2026-11-14 |
| [ai-tool-result-internal-api](ai-tool-result-internal-api.md) | read-tool-result 改 worker 直连 Redis/PG，旧取页 API 已删 | 必核 | 2026-11-14 |
| [ai-file-internal-api](ai-file-internal-api.md) | file 已改 worker 直连 PG/OSS，旧 worker→控制面 API 已删除 | 必核 | 2026-11-14 |
| [ai-skill-internal-api](ai-skill-internal-api.md) | skill-* 留在 agent-runtime 本地执行，worker→控制面旧 API 已删 | 必核 | 2026-11-14 |
| [ai-memory-internal-api](ai-memory-internal-api.md) | memory 已改 worker 直连 DB；旧 worker→控制面内部 API 已删除 | 必核 | 2026-11-14 |
| [tool-worker-executors](tool-worker-executors.md) | worker 执行器契约 + registry；已接 bash/web-fetch；web ref 经 Redis 亲和回同一 worker | 必核 | 2026-11-14 |
| [ai-tool-gateway-control-plane](ai-tool-gateway-control-plane.md) | gateway 已闭环 bash：静态目录 / scope+validate+rate-limit / `ai_tool_audit`；runtime 远程在插件链前短路；**信封必须在审计外层**（写反 → 所有工具 500 `5001`，结果被吞） | 必核 | 2026-11-15 |
| [ai-run-queue](ai-run-queue.md) | 异步子 agent 的会话 run 队列：新表、优先级、dedupe、当前实施边界 | 抽核 | 2026-11-15 |
| [ai-subagent-subconversation](ai-subagent-subconversation.md) | 子 agent 建子会话：run/timeline 挂子会话，工作区/文件归根会话；列表只出根、删父级联；用量仍只算子 run 的父 | 必核 | 2026-11-14 |
| [ai-scale-bottlenecks](ai-scale-bottlenecks.md) | 扛流量的六个卡点：512Mi 限额、无准入、工作区本地盘、Redis 缓冲无字节上限、DB 池 10/实例、时间线无分区 | 必核 | 2026-11-14 |
| [workspace-runtime](workspace-runtime.md) | 执行环境三层（界面选 / 部署限 / 探测证）：默认沙箱、不可用兜底 local；出参 `runtime` 是唯一事实 | 必核 | 2026-11-12 |
| [infra-optional-degradation](infra-optional-degradation.md) | 对象存储未配置/不可达不拦启动；`AGENT_COMMAND_WORK_DIR` 在启动与执行前自愈；问答取消走 `resumeStream({cancelled:true})` | 必核 | 2026-11-11 |
| [ai-chat-scroll](ai-chat-scroll.md) | 进会话自己滑到底：占位让历史加载变成「第二次长高」，走的是 `resize` 不是 `initial`；非流式一律 instant | 抽核 | 2026-11-13 |
| [ai-chat-running-state](ai-chat-running-state.md) | 续流必须带 conversationId（否则串流）；运行中灯走 `ai:owner` 事件驱动 + 重连对账（不再轮询） | 抽核 | 2026-11-13 |
| [engineering-toolchain](engineering-toolchain.md) | oxlint + oxfmt + lefthook：0/0 门禁、oxfmt 0.x 钉版本、Windows sh 转义的坑 | 必核 | 2026-11-13 |
| [packages-layout](packages-layout.md) | 5 个包按运行时分层且单消费者；build 0.9s / typecheck 1.2s，拆包无收益，问题是依赖卫生与入口 | 抽核 | 2026-11-13 |
| [app-start-standalone](app-start-standalone.md) | standalone 下 `next start` 不兼容；统一走 `scripts/start-standalone.ts`，本地端口 9840/9845 | 必核 | 2026-11-13 |
| [sse-transport](sse-transport.md) | AI 会话输出走 Redis pub/sub 定向频道（clientId 存 Redis 进度 Hash）；载荷是 AG-UI 事件，补发按 rev；Kafka 只剩连接器同步 | 抽核 | 2026-11-17 |
| [main-runtime-split](main-runtime-split.md) | 拆分后的边界：main 9989 控制面 + runtime 9990 执行面、内部接口、Kafka 回传、配置事件；6 条已知缺口 | 必核 | 2026-11-14 |
| [admin-shell-layout](admin-shell-layout.md) | admin 三棵布局树共用一条顶栏（会话 / 管理）；共享 Sidebar 是 fixed，侧栏必须行内 top/height 下移 | 必核 | 2026-11-15 |
| [ai-resume-fence](ai-resume-fence.md) | `abortRunStream` 默认 `fenceResume: true`：挂起期间 abort = 永久放弃可恢复性；续跑又挂起时必须跳过它 | 必核 | 2026-11-17 |
| [ai-timeline-part-id](ai-timeline-part-id.md) | text / reasoning 行必须带 `payload.id`（流式 + 非流式两条写入路径）；老数据 2,465 行缺 id 但全在终态 run，不回填 | 必核 | 2026-11-17 |
