# 产品信息口径（README / 落地页 / pitch 共用的数字）

**查证优先级：必核** —— 数字随功能增减漂移；改 README 或 `apps/web` 落地页前先跑「依据」里的命令。

## 结论

对外文案里的能力数字只有这一套口径（2026-11-14 核）：

| 项 | 值 | 出处 |
| --- | --- | --- |
| 内建 AI 工具 | 29（另 3 个运行时自带） | `TOOL_KEYS`：计划 4 + 子 agent + `bash` + 取页 + 联网 3 + 记忆 3 + 技能库 7 + 文件 9 |
| 连接器型号 | 4 | `CONNECTOR_CATALOG`：PostgreSQL / MySQL / Redis / 飞书 CLI |
| 业务模块 | 13 | `apps/server/src/modules/`（含 `share`） |
| 数据表 | 20 | `apps/server/src/database/entities/` |
| ai-elements | 48 | `packages/ui/src/components/ai-elements/*.tsx` |
| 基础组件（shadcn） | 61 | `packages/ui/src/components/ui/*` |
| Agent Skills | 28 | `.agents/skills/*/SKILL.md`（必读 1 + 功能 26 + 元 1） |
| 后台页面 | 监控 5 / AI 8 | `apps/admin/src/app/(app)/main/{monitor,ai}`；AI 八页含记忆、文件与技能库 |
| 检查 | 8 道 | lint / lint:types / fmt:check / typecheck / test / check:inject / check:mastra / check:ui |

协议：MIT（`LICENSE` 与各 `package.json` 的 `license` 一致；2026-11-10 由 ISC 切换）。
README、落地页（`apps/web/src/components/landing/*`）、`docs/guide/`、`docs/billy-pitch.md` 必须同一口径；
改能力时一起改。README 只保留入口级摘要，详情在 `docs/guide/`。工具数只算「内建」的 29 个，
连接器按实例动态产出的工具不计入；Mastra 自动挂的 `skill` / `skill_search` / `skill_read` 单独说明。

## 依据

```bash
node --import tsx -e "import('./apps/server/src/modules/ai/core/tools/tool-keys.ts').then(m=>console.log(Object.keys(m.TOOL_KEYS).length))"  # 29
ls .agents/skills/*/SKILL.md | wc -l                    # 28
ls apps/server/src/database/entities | wc -l            # 20
ls apps/server/src/modules | wc -l                      # 13
ls packages/ui/src/components/ai-elements/*.tsx | wc -l # 48
ls packages/ui/src/components/ui | wc -l                # 61
find apps/admin/src/app -path '*main/ai/*' -name page.tsx | grep -v '\[.*\]' | wc -l  # 8 个菜单页
```

## 失效信号

新增 / 下线工具、连接器型号、业务模块、实体、skill、后台页面或检查脚本时，
本卡数字与 README、落地页、`docs/guide/`、`docs/billy-pitch.md` 同时过期。
