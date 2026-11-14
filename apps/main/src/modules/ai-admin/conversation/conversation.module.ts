import { Module } from '@nestjs/common'
import { AgentCatalogService } from '../../../agent/agent-catalog.service.js'
import { AdminModule } from '../../admin/index.js'
import { AiModelModule } from '../../ai-model/index.js'
import { AiUsageModule } from '../../ai-usage/index.js'
import { AuthModule } from '../../auth/index.js'
import { AiAdminConversationController } from './conversation.controller.js'
import { AiConversationRepository } from './conversation.repository.js'
import { AiAdminConversationService } from './conversation.service.js'
import { AiRunQueryRepository } from './run-query.repository.js'
import { AiTimelineQueryRepository } from './timeline-query.repository.js'

/**
 * AI 会话 / 运行 / 时间线查询 CRUD 模块（`/agent/*` 的查询面）。
 *
 * 依赖方向（刻意保持单向）：
 * - `AuthModule` / `AdminModule`：`AnyAuthGuard` / `AdminAuthGuard`；
 * - `AiModelModule`：`/agent/models` 的可用模型；
 * - `AiUsageModule`：`/agent/usage/*` 的日表汇总与回填；
 * - `AgentCatalogService`：agent 清单 / 状态 / 静态指令**经内部接口问执行面**
 *   （静态声明只在 agent-runtime 有一份，控制面不复制提示词）；
 * - 仓储只碰 `@repo/db` 的实体，**不 import `modules/ai/runtime/**`、Mastra 或 AgentChatService**。
 *
 * 根模块接法：
 * 1. 在 `apps/main/src/root.module.ts` 的 `imports` 加 `AiAdminConversationModule`；
 * 2. 把旧 `AiController`（`modules/ai/api/ai.controller.ts`）的这些路由摘掉，或整体移除
 *    `AiModule` —— 两处都注册 `/agent/*` 时 Nest 以先注册者为准，行为会取决于 import 顺序；
 * 3. `apps/main/src/agent/agent-sse.controller.ts` 的 `/agent/chat/stream` 保持不动。
 */
@Module({
  imports: [AuthModule, AdminModule, AiModelModule, AiUsageModule],
  controllers: [AiAdminConversationController],
  providers: [
    AiConversationRepository,
    AiRunQueryRepository,
    AiTimelineQueryRepository,
    {
      // 手工装配：客户端只包一层 HTTP + 内存缓存，不进容器依赖链（也不写 DI 装饰器）
      provide: AgentCatalogService,
      useFactory: () =>
        new AgentCatalogService({
          baseUrl: process.env.AGENT_RUNTIME_URL ?? 'http://127.0.0.1:9990',
          token: process.env.AGENT_INTERNAL_TOKEN ?? '',
        }),
    },
    AiAdminConversationService,
  ],
  exports: [AiAdminConversationService],
})
export class AiAdminConversationModule {}
