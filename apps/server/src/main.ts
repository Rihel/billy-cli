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
import { makeStorageRoutes } from './features/storage.js';
import { makeTodoRoutes } from './features/todo.js';
import { makeUserRoutes } from './features/user.js';
import { AdminEntity } from './database/entities/admin-entity.js';
import { TodoEntity } from './database/entities/todo-entity.js';
import { UserEntity } from './database/entities/user-entity.js';
import { AdminRepository } from './modules/admin/admin.repository.js';
import { AdminService } from './modules/admin/admin.service.js';
import { AuthService } from './modules/auth/auth.service.js';
import { TodoRepository } from './modules/todo/todo.repository.js';
import { TodoService } from './modules/todo/todo.service.js';
import { UserRepository } from './modules/user/user.repository.js';
import { UserService } from './modules/user/user.service.js';

/** 应用组合根：唯一装配点（创建一次，供路由与启停共用） */
export const runtime: AppContext = createServiceContext({
  db: {
    url: process.env.DB_URL,
    entities: [UserEntity, TodoEntity, AdminEntity],
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
})
  // 应用层业务配置
  .addConstant(ServerConfig, serverConfig)
  // 仓储
  .addService(UserRepository)
  .addService(TodoRepository)
  .addService(AdminRepository)
  // 业务服务
  .addService(AuthService)
  .addService(UserService)
  .addService(TodoService)
  .addService(AdminService);

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
  app.notFound(notFound);
  app.onError(errorHandler);

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
