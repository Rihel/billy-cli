# AI 文件管理：ai_files + 9 个文件工具 + 每会话 workspace

**查证优先级：必核**（改文件工具 / `ai_files` / 右栏文件 tab 前复核）

## 结论

- 表 `ai_files`：`(conversation_id, path)` 唯一；`source='user'` 是入站附件引用（内容寻址、可跨会话共享，
  删会话**不删对象**），`source='ai'` 是 AI 提交（删会话删对象）。`sha256` 入站可空。
- key：AI `user/{userId}/{conversationId}/{fileKey}`（admin `admin/…`）；入站沿用附件 key
  `user/{userId}/{md5}{ext}`。`uploads/` 前缀保留给入站，`file-submit` 拒绝。
- 9 工具：`file-submit/file-download/file-list` + `read-file/file-search/workspace-files/write-file/replace-file/append-file`；
  组级 `child:'deny'`，配置在 `files/file.schemas.ts`，业务在 `files/file.service.ts`。
- **两条链的取法不同**（2026-11-15 起）：右栏文件树走 `POST /agent/file/workspace`（controller 传
  `all: true`）→ **一次返回全量一维数组** + `depthLimited`，树由前端拼；**模型工具** `workspace-files`
  才分页（`offset` 入参、一页 `workspaceMaxFiles`=500、出参 `hasMore`），因为那是 token 预算问题。
  `truncated` 已删除；遍历按目录名**码位**排序（不用 `localeCompare`），否则分页边界会漂。
  深度上限 `workspaceMaxDepth` 默认 16（工具侧读库里的配置，改默认值要同步 `ai_tools.config`）。
- **噪音目录清单** `NOISE_DIRS` / `NOISE_FILES` 在 `file.service.ts` 顶部（24 个目录 + 3 类文件，
  含 node_modules/.git/dist/.next/.turbo/.cache/.venv 等），`workspace-files` 与 `file-search` 共用；
  `files/` `uploads/` 仍由 `includeCaches` 单独控制，别混为一谈。
- workspace：`{AGENT_COMMAND_WORK_DIR || ~/.billy/workspaces}/{conversationId}`；`BashTool` 与文件工具共用；
  `BashConfig.workDir` 已退役。入站物化到 `uploads/`，`file-download` 默认放 `files/`；`files/` 拒绝写（缓存会被覆盖）。
  **2026-11-22 补**：会话绑了容器工作区时，模型面文件工具读写的真身是容器 `/workspace`（走 workspace-service），
  宿主那份只剩「入站附件物化 / 自托管本地后端」；引擎侧往工作区写文件也必须走执行面（见
  `ai-subagent-result-and-wake` 第 5 条），不能直接用宿主本地 `FileService`。
- HTTP：`POST /agent/file/workspace`、`POST /agent/file/preview`（source ai/workspace）、
  `GET /agent/file/workspace-content`（cookie + Range + inline/attachment）。
- **单文件删除（2026-11-21）**：`POST /agent/file/remove`（会话侧，先 `requireOwned` 再按
  `conversationId` 校验归属）与 `POST /agent/file/admin/remove`（管理员，任意会话）。
  语义是**硬删**：先删 OSS 对象（**只删 `source='ai'` 的**；入站附件内容寻址、可能跨会话共用，
  与 `cleanupConversation` 同口径；失败只 warn 不阻断），再 `ai_files` **物理删除**
  （`FileRepository.hardDelete`，不是会话清理用的软删 —— 软删会让 `(conversation_id, path)` 唯一键
  继续占位，重新上传同名文件会踩唯一键）。`AgentFileModel` 因此多带一个 `id`（前端按 id 删）。
  工作区文件（`workspace` 源）不在这条链上，走 `WORKSPACE_FS_PORT.remove`。
- **对象存储桶默认私有（2026-11-14 起）**：预览 / 下载一律由服务端签**短时预签名**地址
  （前端 `useStorageUrl` / `client.storage.getDownloadUrl`；聊天文件面板与文件页走 `loadUrl`）；
  `formatStorageUrl` 只对绝对 URL 有效，不能再拿 key 拼公开地址。
- 提示词：`requirements.eta` 的文件纪律；`html` 围栏 prompt 已退役，组件软保留。
- **HTML 预览可引 CDN 库**（2026-11-12）：沙箱 CSP 白名单 = `SANDBOX_CDN_HOSTS`（`@repo/shared`）：
  `registry.npmmirror.com` → `cdn.jsdelivr.net` → `unpkg.com`，只放行脚本 / 样式 / 图片 / 字体，
  `connect-src 'none'`、表单、框架仍全禁。写法在**内置技能** `catalog/html-page`，提示词只留
  「写任何 HTML 之前先加载 `html-page`」（无条件段，`.html` 文件与 `html` / `gsap` 围栏都算）+ 白名单三行
  （细节搬进技能是为了不让它每轮付 token）。
- **整页默认拆片段 + 构建**（2026-11-17）：`catalog/html-page` 带 `scripts/build-html.mjs`（include 展开 /
  css-js 内联 / 产物校验，零依赖、无网络）与 `references/build-pipeline.md`。流程 = `src/index.html` 骨架 +
  `src/sections/*.html` → `node scripts/build-html.mjs` → `dist/index.html` → `file-submit`；没有 bash / node 时
  退化为分片 `append-file`。`SKILL.md` 只留流程与硬口径（正文 < 150 行，测试钉住），细节在
  `references/{sandbox,styles,libraries,checklist,build-pipeline}.md`。**技能目录整树随包**：`copy-assets`
  现在对 `skills/catalog/**` 全收（以前只收 `.md` / `.eta`，`.mjs` 会漏在镜像外，表现为模型读不到技能脚本）。
- **存量页面实测**（2026-11-17，`~/.billy/workspaces` + `~/.billy-cli` 共 25 个）：全部零本地资源引用、
  零 `fetch` / XHR / WebSocket / 表单 / iframe / module import，22–87KB，可直接被 `build-html.mjs` 合并（25/25）；
  10 个未引 Tailwind（`no-tailwind` warning）。审计发现校验曾误扫 `<script>` 体内（`url(%23n)` 被当相对引用，4 个页面必挂），
  已改为只扫标记与样式。
- **Tailwind 在沙箱里可用**（2026-11-13 实测）：`@tailwindcss/browser@4.3.5` 由三家 CDN 的
  `dist/index.global.js` 取同一个文件，加载后扫描 DOM 注入 `<style>`；在沙箱同款 CSP
  （`style-src 'unsafe-inline'`）下 `bg-red-500` / `p-4` / `text-center` 均生效。它**无全局变量**，
  三级兜底只能用 `onerror` 链。字体口径：一律无衬线（禁 `font-serif` / 宋体）。
  **样式口径（2026-11-14）**：主体样式**必须**用 Tailwind 工具类写（布局 / 间距 / 排版 / 配色，
  每个页面都要引 `@tailwindcss/browser`）；`<style>` **不禁用**，用来补 Tailwind 覆盖不到的
  （动画 / 伪元素 / 打印 / 库覆盖 / `@theme`），但不得整页绕开工具类或引第二套框架；
  由 `catalog/html-page` 与 `test/ai-builtin-skills.test.ts` 的断言共同钉住。
- **html-page 补三类库**（2026-11-15 三家 CDN 实测）：常用库表加 `@svgdotjs/svg.js@3.2.8`
  （`dist/svg.min.js`，`SVG`）、`konva@10.9.1`（`konva.min.js`，`Konva`）、`gsap@3.15.1`
  （`dist/gsap.min.js`）、`katex@0.19.1`（`dist/katex.min.js` + `dist/katex.min.css`，字体随 CSS 相对路径）。
  **内置 gsap 只对 `gsap` 围栏生效**：`.html` 预览（`SandboxFrame language="html"`）不注入任何脚本，
  页面里要动画必须自己引。`two.js` / `paper` 不在 cnpm 的 unpkg 白名单（npmmirror 返回 403），
  只能走 jsDelivr / unpkg，不要当国内第一跳。
  核对：`curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmmirror.com/konva/10.9.1/files/konva.min.js`
  （逐个换包名 / 版本 / 路径，三家都 200 才算进表）。

## 坑

- **`packages/ai-data` 没有 `dev` 脚本**，不在 `pnpm dev:pkgs` 的 watch 里：
  改完必须手动 `pnpm --filter @repo/ai-data run build`，否则 runtime / main / worker 加载的是旧 `dist`，
  跑测试却全绿（测试走 src）。2026-11-18 起 `@repo/tool-catalog` 已删，不再有 `gen:tool-catalog` 这一步。
- `AgentChatService` / `AgentConversationService` 新增依赖必须放构造器**末尾**：手工测试按位置传参，插中间会全错位。
- 工作区根不存在时不能 `realpath(root)` 做包含判断（会把“待创建”误判越界）；以最近已存在祖先 + base 根判断。
- `ai_files` upsert 必须用原生 SQL 把 `deleted_at` 置 null；TypeORM 软删过滤会撞唯一键。
- `file-search` 默认 AND。

## 依据

- `docs/design/ai-file-manager.md`（§3 / §6 / §8 / §15）
- `apps/agent-runtime/src/modules/ai/files/**`、`apps/agent-runtime/src/modules/ai/core/tools/workspace.ts`
- 核对：`pnpm --filter @app/agent-runtime test test/ai-file-service.test.ts test/ai-tools-battery.test.ts`；
  CDN 白名单：`grep -rn "SANDBOX_CDN_HOSTS" packages/shared/src packages/ui/src apps/agent-runtime/test`；
  技能资产随包：`ls apps/agent-runtime/{src,dist}/modules/ai/core/skills/catalog/html-page/{scripts,references}`
- 分页 / 噪音目录现状：
  `grep -n "hasMore\|NOISE_DIRS" packages/ai-data/src/file/file.service.ts`、
  `PGPASSWORD=pg1234 psql -h localhost -U root -d billy-cli -At -c "select tool_key, config->>'workspaceMaxDepth', config->>'workspaceMaxFiles' from ai_tools where tool_key='workspace-files';"`

## 失效信号

- 表结构 / key 公式 / workspace 布局 / 工具 key 改动；多副本 workspace 策略改动；
  桶策略（公开读 / 私有）与预签名链路改动时，`files-panel` / 文件页 / `useStorageUrl` 要跟着看；
  CDN 白名单（`SANDBOX_CDN_HOSTS`）改动时提示词与两个包的测试要跟着改；
  技能目录里新增资产类型（`.mjs` / 脚本 / 素材）时 `copy-assets` 的 `skills/catalog/**` 规则要保持覆盖。
