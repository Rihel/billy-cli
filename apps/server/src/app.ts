import { AppConfig, appCore, initCore, startCore, stopCore } from '@repo/core';
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
import { makeAuthRoutes } from './features/auth.js';
import { makeStorageRoutes } from './features/storage.js';
import { makeTodoRoutes } from './features/todo.js';
import { makeUserRoutes } from './features/user.js';

export const makeApp = () => {
  initCore({
    db: {
      sync: true,
    },
  });

  const app = new Hono();

  app.use(
    '*',
    cors(),
    makeRequestContextMiddleware(requestContext),
    requestLogger,
  );
  app.route('/auth', makeAuthRoutes());
  app.route('/user', makeUserRoutes());
  app.route('/todo', makeTodoRoutes());
  app.route('/storage', makeStorageRoutes());
  app.notFound(notFound);
  app.onError(errorHandler);

  return app;
};

const app = makeApp();

export const program = async () => {
  const config = appCore.get<AppConfig>(AppConfig);
  const logger = createLogger('server', true);
  await startCore();
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
        void stopCore().then(
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
