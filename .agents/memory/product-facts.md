# 产品信息口径（README / 落地页 / pitch 共用的数字）

**查证优先级：必核** —— 数字随功能增减漂移；改 README 或 `apps/web` 落地页前先跑「依据」里的命令。

## 结论

对外文案里的能力数字只有这一套口径（2026-11-10 核）：

| 项 | 值 | 出处 |
| --- | --- | --- |
| 内建 AI 工具 | 10 | `TOOL_KEYS`：计划四件套 + 子 agent + 命令 + 取页 + 联网三件套 |
| 连接器型号 | 4 | `CONNECTOR_CATALOG`：PostgreSQL / MySQL / Redis / 飞书 CLI |
| 业务模块 | 12 | `apps/server/src/modules/` |
| 数据表 | 15 | `apps/server/src/database/entities/` |
| ai-elements | 48 | `packages/ui/src/components/ai-elements/*.tsx` |
| 基础组件（shadcn） | 61 | `packages/ui/src/components/ui/*` |
| Agent Skills | 27 | `.agents/skills/*/SKILL.md`（必读 1 + 功能 25 + 元 1） |
| 后台页面 | 监控 5 / AI 5 | `apps/admin/src/app/main/{monitor,ai}` |
| 检查 | 5 道 | typecheck / test / check:inject / check:mastra / check:ui |

协议：MIT（`LICENSE` 与各 `package.json` 的 `license` 一致；2026-11-10 由 ISC 切换）。
README 与落地页（`apps/web/src/components/landing/*`）必须同一口径；改能力时两处一起改。
README 只保留入口级摘要，详细说明在 `docs/guide/`（architecture / backend / frontend / packages / ai / deployment）；
改能力时连对应 guide 与 skill 一起同步。工具数只算「内建」的 19 个（原 10 + 文件管理 9），连接器按实例动态产出的工具不计入。

## 依据

```bash
grep -c "@ToolDecl" apps/server/src/modules/ai/tools/{planner/planner.tools.ts,subagent.tool.ts,bash.tool.ts,read-tool-result.tool.ts,web.tools.ts}  # 4+1+1+1+3=10
ls .agents/skills/*/SKILL.md | wc -l                    # 27
ls apps/server/src/database/entities | wc -l            # 15
ls apps/server/src/modules | wc -l                      # 12
ls packages/ui/src/components/ai-elements/*.tsx | wc -l # 48
ls packages/ui/src/components/ui | wc -l                # 61
grep -n "export const CONNECTOR_CATALOG" -A 6 apps/server/src/modules/ai/connectors/connector.catalog.ts
```

## 失效信号

新增 / 下线工具、连接器型号、业务模块、实体、skill、后台页面或检查脚本时，
本卡数字与 README、落地页、`docs/guide/`、`docs/billy-pitch.md` 同时过期。
