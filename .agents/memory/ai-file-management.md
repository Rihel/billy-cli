# AI 文件管理：ai_files + 9 个文件工具 + 每会话 workspace

**查证优先级：必核**（改文件工具 / `ai_files` / 右栏文件 tab 前复核）

## 结论

- 表 `ai_files`：`(conversation_id, path)` 唯一；`source='user'` 是入站附件引用（内容寻址、可跨会话共享，
  删会话**不删对象**），`source='ai'` 是 AI 提交（删会话删对象）。`sha256` 入站可空。
- key：AI `user/{userId}/{conversationId}/{fileKey}`（admin `admin/…`）；入站沿用附件 key
  `user/{userId}/{md5}{ext}`。`uploads/` 前缀保留给入站，`file-submit` 拒绝。
- 9 工具：`file-submit/file-download/file-list` + `read-file/file-search/workspace-files/write-file/replace-file/append-file`；
  组级 `child:'deny'`，配置在 `files/file.schemas.ts`，业务在 `files/file.service.ts`。
- workspace：`{AGENT_COMMAND_WORK_DIR || ~/.billy/workspaces}/{conversationId}`；`BashTool` 与文件工具共用；
  `BashConfig.workDir` 已退役。入站物化到 `uploads/`，`file-download` 默认放 `files/`；`files/` 拒绝写（缓存会被覆盖）。
- HTTP：`POST /agent/file/workspace`、`POST /agent/file/preview`（source ai/workspace）、
  `GET /agent/file/workspace-content`（cookie + Range + inline/attachment）。
- 提示词：`requirements.eta` 的文件纪律；`html` 围栏 prompt 已退役，组件软保留。
- **HTML 预览可引 CDN 库**（2026-11-12）：沙箱 CSP 白名单 = `SANDBOX_CDN_HOSTS`（`@repo/shared`）：
  `registry.npmmirror.com` → `cdn.jsdelivr.net` → `unpkg.com`，只放行脚本 / 样式 / 图片 / 字体，
  `connect-src 'none'`、表单、框架仍全禁。写法在**内置技能** `catalog/html-page`，提示词只留
  「写任何 HTML 之前先加载 `html-page`」（无条件段，`.html` 文件与 `html` / `gsap` 围栏都算）+ 白名单三行
  （细节搬进技能是为了不让它每轮付 token）。
- **Tailwind 在沙箱里可用**（2026-11-13 实测）：`@tailwindcss/browser@4.3.5` 由三家 CDN 的
  `dist/index.global.js` 取同一个文件，加载后扫描 DOM 注入 `<style>`；在沙箱同款 CSP
  （`style-src 'unsafe-inline'`）下 `bg-red-500` / `p-4` / `text-center` 均生效。它**无全局变量**，
  三级兜底只能用 `onerror` 链。字体口径：一律无衬线（禁 `font-serif` / 宋体）。

## 坑

- `AgentChatService` / `AgentConversationService` 新增依赖必须放构造器**末尾**：手工测试按位置传参，插中间会全错位。
- 工作区根不存在时不能 `realpath(root)` 做包含判断（会把“待创建”误判越界）；以最近已存在祖先 + base 根判断。
- `ai_files` upsert 必须用原生 SQL 把 `deleted_at` 置 null；TypeORM 软删过滤会撞唯一键。
- `file-search` 默认 AND；`workspace-files` 默认隐藏 `files/` / `uploads/`。

## 依据

- `docs/design/ai-file-manager.md`（§3 / §6 / §8 / §15）
- `apps/server/src/modules/ai/files/**`、`apps/server/src/modules/ai/core/tools/workspace.ts`
- 核对：`pnpm --filter @app/server test test/ai-file-service.test.ts test/ai-tools-battery.test.ts`；
  CDN 白名单：`grep -rn "SANDBOX_CDN_HOSTS" packages/shared/src packages/ui/src apps/server/test`

## 失效信号

- 表结构 / key 公式 / workspace 布局 / 工具 key 改动；多副本 workspace 策略改动；桶改私有；
  CDN 白名单（`SANDBOX_CDN_HOSTS`）改动时提示词与两个包的测试要跟着改。
