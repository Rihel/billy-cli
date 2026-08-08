import { ApplicationLogger, makeRuntimeLayer } from '@repo/core';
import { serve } from '@hono/node-server';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { AuthenticationLive } from './capabilities/authentication.js';
import {
  EffectExecutor,
  EffectExecutorLive,
} from './capabilities/effect-executor.js';
import { HttpLive, errorHandler, notFound } from './capabilities/http.js';
import {
  RequestContextStorage,
  RequestContextStorageLive,
  makeRequestContextMiddleware,
} from './capabilities/request-context.js';
import { makeAuthRoutes } from './features/auth.js';
import { makeStorageRoutes } from './features/storage.js';
import { makeTodoRoutes } from './features/todo.js';
import { makeUserRoutes } from './features/user.js';
import { runtimeConfig } from './config.js';

const CoreLive = makeRuntimeLayer(runtimeConfig);

const ExecutorProvidedLive = EffectExecutorLive.pipe(
  Layer.provide(Layer.merge(CoreLive, RequestContextStorageLive)),
);

const AuthenticationProvidedLive = AuthenticationLive.pipe(
  Layer.provide(Layer.merge(ExecutorProvidedLive, RequestContextStorageLive)),
);

const AppLive = Layer.mergeAll(
  RequestContextStorageLive,
  CoreLive,
  ExecutorProvidedLive,
  HttpLive,
  AuthenticationProvidedLive,
);

const appRuntime = ManagedRuntime.make(AppLive);

export const makeApp = Effect.gen(function* () {
  const authRoutes = yield* makeAuthRoutes;
  const userRoutes = yield* makeUserRoutes;
  const todoRoutes = yield* makeTodoRoutes;
  const storageRoutes = yield* makeStorageRoutes;
  const requestStorage = yield* RequestContextStorage;
  const app = new Hono();

  app.use(
    '*',
    cors(),
    honoLogger(),
    makeRequestContextMiddleware(requestStorage),
  );
  app.route('/auth', authRoutes);
  app.route('/user', userRoutes);
  app.route('/todo', todoRoutes);
  app.route('/storage', storageRoutes);
  app.notFound(notFound);
  app.onError(errorHandler);

  return app;
});

const app = await appRuntime.runPromise(makeApp);
const disposeApp = () => appRuntime.dispose();

export const program = Effect.gen(function* () {
  const applicationLogger = yield* Effect.promise(() =>
    appRuntime.runPromise(ApplicationLogger),
  );
  const server = serve(
    {
      fetch: app.fetch,
      port: runtimeConfig.port,
    },
    (info) => applicationLogger.info('服务已启动', info),
  );

  yield* Effect.async<void, unknown>((resume) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      applicationLogger.info('正在关闭服务...');
      server.close(() => {
        void disposeApp().then(
          () => resume(Effect.void),
          (error) => resume(Effect.fail(error)),
        );
      });
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    return Effect.sync(() => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
    });
  });
});
