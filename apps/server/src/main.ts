import 'dotenv/config';
import { AppConfig, createAppContext } from '@repo/core';
import type { AppContext } from '@repo/di';
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

/** 应用组合根：唯一装配点（创建一次，供路由与启停共用） */
export const runtime: AppContext = createAppContext({ db: { sync: true } });

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
  const config = runtime.get<AppConfig>(AppConfig);
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
