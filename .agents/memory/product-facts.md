# 产品信息口径（README / 落地页 / pitch / guide 共用的数字）

**查证优先级：必核** —— 数字随功能增减漂移；改 README / 落地页 / pitch / `docs/guide/` 前先跑「依据」里的命令。

## 结论

对外文案里的能力数字只有这一套口径（**2026-11-20 核**，对应能力目录 / 工作区执行面改造后的 HEAD）：

| 项 | 值 | 出处 |
| --- | --- | --- |
| 工具面 key | **35** = 本地编排 15 + 能力服务 17 + 网关内建 3 | `TOOL_KEYS` 35 个；本地编排 = 计划 4 + 子 agent 4 + 技能库 7 |
| 能力目录（code） | **20** = common 9 + workspace 8 + 网关内建 3 | `@CapabilityDecl` 声明：common 17（bash + 7 个工作区文件按 `execution.where='workspace'` 过滤，实际登记 9）、workspace-service 8、gateway 内建 3 |
| MCP / 外部服务 | 数量随登记（`source='manual'`） | 不随工具面下发，`tool-search` 命中的下一轮才进工具面 |
| Nest 服务 | **6** | main 9989 / agent-runtime 9990 / model-gateway 9992 / capability-gateway 9993 / common-capability 9994 / workspace-service 9995 |
| 连接器型号 | 0 | 模块已于 2026-11-18 删除（原 4 个型号：PostgreSQL / MySQL / Redis / 飞书 CLI） |
| 业务模块 | 13 | `apps/main/src/modules/`（含 `ai-admin`、`ai-model`、`ai-usage`） |
| 数据表 | 26 实体 / 38 迁移 | `packages/db/src/entities` / `migrations`（唯一来源 `@repo/db`） |
| ai-elements | 48 | `packages/ui/src/components/ai-elements/*.tsx` |
| 基础组件（shadcn） | 61 | `packages/ui/src/components/ui/*.tsx` |
| Agent Skills | 28 | `.agents/skills/*/SKILL.md`（必读 1 + 功能 26 + 元 1） |
| 后台页面 | 监控 5 / AI 管理 10（另有会话工作台、技能编辑器） | `apps/admin/src/components/AppMenu.tsx`；AI 管理 = 模型 / 网关用量 / 上游 Key / 技能库 / 记忆 / 文件 / 工作区 / 能力服务 / 服务授权 / 审计 |
| 检查 | 9 道 | lint / lint:types / fmt:check / typecheck / test + check:inject / check:mastra / check:redis-raw / check:ui |

协议：MIT（`LICENSE` 与各 `package.json` 的 `license` 一致；2026-11-10 由 ISC 切换）。
README、落地页（`apps/web/src/components/landing/*`）、`docs/billy-pitch.md`、`docs/guide/` 必须同一口径；
改能力时一起改。README 只保留入口级摘要，详情在 `docs/guide/`。工具数只算「内建」的 35 个，
Mastra 自动挂的 `skill` / `skill_search` / `skill_read` 单独说明；连接器已删除，不再计入。

## 依据

```bash
node --import tsx -e "import('./apps/agent-runtime/src/modules/ai/core/tools/tool-keys.ts').then(m=>console.log(Object.keys(m.TOOL_KEYS).length))"  # 35
grep -rn "@CapabilityDecl(" apps/common-capability/src | wc -l        # 17 声明（登记 9）
grep -rn "@CapabilityDecl(" apps/workspace-service/src | wc -l        # 8
grep -c "@CapabilityDecl(" apps/capability-gateway/src/registry/builtin.capabilities.ts  # 3
ls apps/*/package.json | wc -l                                        # 8 个 app（6 个 Nest）
ls packages/*/package.json | wc -l                                    # 12 个 package
ls packages/db/src/entities | grep -v index | wc -l                   # 26 实体
ls packages/db/src/migrations | grep -v index | wc -l                 # 38 迁移
ls apps/main/src/modules | wc -l                                      # 13 个模块目录
ls .agents/skills/*/SKILL.md | wc -l                                  # 28
ls packages/ui/src/components/ai-elements/*.tsx | wc -l               # 48
ls packages/ui/src/components/ui/*.tsx | wc -l                        # 61
```

## 失效信号

新增 / 下线工具、能力服务、业务模块、实体、skill、后台页面或检查脚本时，
本卡数字与 README、落地页、`docs/billy-pitch.md`、`docs/guide/` 同时过期。
