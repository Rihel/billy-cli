import 'dotenv/config';
import { createServiceContext } from '@repo/kits';
import type { AppContext } from '@repo/di';
import { ServerConfig, serverConfig } from './config.js';
import { createLogger } from '@repo/shared/logger';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { errorHandler, notFound } from './lib/http.js';
import {
  makeRequestContextMiddleware,
  requestContext,
} from './lib/request-context.js';
import { requestLogger } from './lib/request-logger.js';
import { makeAdminRoutes } from './features/admin.js';
import { makeAuthRoutes } from './features/auth.js';
import { makeConfigRoutes } from './features/config.js';
import { makeMonitorRoutes } from './features/monitor.js';
import { makeStorageRoutes } from './features/storage.js';
import { makeStreamRoutes } from './features/stream.js';
import { makeTodoRoutes } from './features/todo.js';
import { makeUserRoutes } from './features/user.js';
import { AdminEntity } from './database/entities/admin-entity.js';
import { AlertLogEntity } from './database/entities/alert-log-entity.js';
import { AlertRuleEntity } from './database/entities/alert-rule-entity.js';
import { TodoEntity } from './database/entities/todo-entity.js';
import { UserEntity } from './database/entities/user-entity.js';
import { AdminRepository } from './modules/admin/admin.repository.js';
import { AdminService } from './modules/admin/admin.service.js';
import { AuthService } from './modules/auth/auth.service.js';
import {
  AlertLogRepository,
  AlertRuleRepository,
  AlertRuleService,
  MonitorService,
  monitorConfig,
  MonitorConfig,
} from './modules/monitor/index.js';
import { TodoRepository } from './modules/todo/todo.repository.js';
import { TodoService } from './modules/todo/todo.service.js';
import { UserRepository } from './modules/user/user.repository.js';
import { UserService } from './modules/user/user.service.js';

/** 应用组合根：唯一装配点（创建一次，供路由与启停共用） */
export const runtime: AppContext = createServiceContext({
  db: {
    url: process.env.DB_URL,
    entities: [UserEntity, TodoEntity, AdminEntity, AlertRuleEntity, AlertLogEntity],
    sync: true,
  },
  redis: { url: process.env.REDIS_URL },
  jwt: { secret: process.env.JWT_SECRET },
  storage: {
    provider: process.env.OBJECT_STORAGE_PROVIDER as 's3' | 'cos',
    region: process.env.OBJECT_STORAGE_REGION,
    bucket: process.env.OBJECT_STORAGE_BUCKET,
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
  },
  auth: { passwordHashRounds: process.env.PASSWORD_HASH_ROUNDS },
  logger: { name: 'server', pretty: process.env.NODE_ENV !== 'production' },
  notify: {
    lark: process.env.LARK_NOTIFY_RECEIVE_ID
      ? { receiveId: process.env.LARK_NOTIFY_RECEIVE_ID }
      : undefined,
    email: process.env.ALERT_SMTP_HOST
      ? {
          host: process.env.ALERT_SMTP_HOST,
          port: Number(process.env.ALERT_SMTP_PORT ?? 465),
          secure: process.env.ALERT_SMTP_SECURE !== 'false',
          user: process.env.ALERT_SMTP_USER || undefined,
          pass: process.env.ALERT_SMTP_PASS || undefined,
          from: process.env.ALERT_SMTP_FROM ?? '',
        }
      : undefined,
  },
  lark:
    process.env.LARK_APP_ID && process.env.LARK_APP_SECRET
      ? { appId: process.env.LARK_APP_ID, appSecret: process.env.LARK_APP_SECRET }
      : undefined,
})
  // 应用层业务配置
  .addConstant(ServerConfig, serverConfig)
  .addConstant(MonitorConfig, monitorConfig)
  // 仓储
  .addService(UserRepository)
  .addService(TodoRepository)
  .addService(AdminRepository)
  .addService(AlertRuleRepository)
  .addService(AlertLogRepository)
  // 业务服务
  .addService(AuthService)
  .addService(UserService)
  .addService(TodoService)
  .addService(AdminService)
  .addService(AlertRuleService)
  .addService(MonitorService);

export const makeApp = () => {
  const app = new Hono();

  app.use(
    '*',
    cors(),
    makeRequestContextMiddleware(requestContext),
    requestLogger,
  );
  app.route('/auth', makeAuthRoutes(runtime));
  app.route('/admin', makeAdminRoutes(runtime));
  app.route('/user', makeUserRoutes(runtime));
  app.route('/todo', makeTodoRoutes(runtime));
  app.route('/storage', makeStorageRoutes(runtime));
  app.route('/sse', makeStreamRoutes(runtime));
  app.route('/monitor', makeMonitorRoutes(runtime));
  app.route('/config', makeConfigRoutes(runtime));
  app.notFound(notFound);
  app.onError((error, context) => {
    // 告警接入：技术错误异步通知（fire-and-forget，失败不影响错误响应）
    try {
      void runtime.get(MonitorService).notifyError(error, {
        path: context.req.path,
        requestId: context.res.headers.get('X-Request-Id') ?? undefined,
      });
    } catch {
      // 告警链路异常不影响返回
    }
    return errorHandler(error, context);
  });

  return app;
};

const app = makeApp();

export const program = async () => {
  const logger = createLogger('server', true);
  await runtime.start();
  const config = runtime.get<typeof serverConfig>(ServerConfig);
  const server = serve(
    {
      fetch: app.fetch,
      port: config.port,
    },
    (info) => logger.info('服务已启动', info),
  );

  // 进程级异常告警：未捕获异常记录后退出（避免进程悬挂）；未处理拒绝记录不退出
  process.on('uncaughtException', (error) => {
    logger.error('未捕获异常', { error });
    try {
      void runtime.get(MonitorService).notifyError(error);
    } catch {
      // 告警链路异常不影响退出
    }
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝', { error: reason });
    try {
      void runtime.get(MonitorService).notifyError(reason);
    } catch {
      // 忽略
    }
  });

  await new Promise<void>((resolve) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      logger.info('正在关闭服务...');
      server.close(() => {
        void runtime.stop().then(
          () => resolve(),
          (error) => {
            logger.error('关闭资源失败', { error });
            resolve();
          },
        );
      });
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
};

void program();
