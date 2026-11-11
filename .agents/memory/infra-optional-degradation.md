# 可选基础设施不得拦启动；AI workspace 根要自愈

**查证优先级：必核**（改对象存储启动、`bash` 工作目录前复核）

## 结论

- **对象存储是可选能力**：`StorageConfigSchema.endpoint` **没有默认值**（2026-11-11 起）。
  S3 未配 `OBJECT_STORAGE_ENDPOINT` = 未启用；`ObjectStorage.onApplicationBootstrap` 只记
  `storage.disabled` / `storage.init_failed` 警告，**不抛**；初始化失败不缓存失败结果，
  首次使用重试。真正用到存储的调用抛 `ObjectStorageUnavailableError`（中文，指向配置项）。
- **`AGENT_COMMAND_WORK_DIR` 就是 AI 的 workspace 根**：`BashTool` 在
  `onApplicationBootstrap` 与每次 `execute` 前 `mkdir -p` 兜底；根目录被删后新建会话里的命令
  不会全部因 cwd 不存在失败。建不出来只记 `ai.command.workspace_unavailable`，不拦启动。
- **问答取消**走 `resumeStream({ cancelled: true })`，因为 Mastra 的 `declineToolCall()`
  只对 `requireApproval` 审批挂起有效，对 `suspend()` 不适用（官方 Human-in-the-loop 文档）。
  时间线出参 `{ cancelled: true, answers: [] }`，历史据此把问题卡显示为「已取消」。

## 坑

- 早先 endpoint 默认 `http://localhost:9000`：没部署 MinIO 的环境启动即失败，本地又把
  「没配」伪装成「配了但连不上」；两者都让可选能力变成必选依赖。
- 启动钩子里 `await provider.initial()` 不 catch，Nest 会因此整个起不来；
  可选依赖的启动初始化必须「失败只警告」，把失败留到使用点。

## 依据

- `packages/kits/src/storage/storage.config.ts`、`object-storage.ts`、
  `foundation/errors/infrastructure-errors.ts`（`ObjectStorageUnavailableError`）
- `apps/server/src/modules/ai/tools/bash.tool.ts`
- `apps/server/src/modules/ai/mastra/ask-user-questions.tool.ts`、`runtime/chat.service.ts`
- 核对命令：
  - `grep -n "endpoint" packages/kits/src/storage/storage.config.ts`
  - `grep -n "onApplicationBootstrap\|mkdir" packages/kits/src/storage/object-storage.ts apps/server/src/modules/ai/tools/bash.tool.ts`
  - `pnpm --filter @repo/kits exec vitest run test/object-storage.test.ts && pnpm --filter @app/server exec vitest run test/ai-tools/bash.test.ts test/ai-tools/ask-user-questions.test.ts`

## 失效信号

- 对象存储重新变成必需依赖（启动即校验 endpoint / 建桶失败即退出）；
- `bash` 工作根改为启动期一次性创建且不再按执行兜底；
- Mastra 给 `suspend()` 增加独立的取消 / decline 入口。
