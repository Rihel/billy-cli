import { Effect, Layer, ManagedRuntime } from 'effect';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { AppConfig, AppConfigLive } from './capabilities/app-config.js';
import { AuthenticationLive } from './capabilities/authentication.js';
import {
  EffectExecutor,
  EffectExecutorLive,
} from './capabilities/effect-executor.js';
import {
  HttpLive,
  errorHandler,
  notFound,
  type AppEnv,
} from './capabilities/http.js';
import {
  RequestContextStorage,
  RequestContextStorageLive,
  makeRequestContextMiddleware,
} from './capabilities/request-context.js';
import { makeAuthRoutes } from './features/auth/index.js';
import { makeStorageRoutes } from './features/storage/index.js';
import { makeTodoRoutes } from './features/todo/index.js';
import { makeUserRoutes } from './features/user/index.js';

const ExecutorProvidedLive = EffectExecutorLive.pipe(
  Layer.provide(Layer.merge(AppConfigLive, RequestContextStorageLive)),
);
const AuthenticationProvidedLive = AuthenticationLive.pipe(
  Layer.provide(Layer.merge(ExecutorProvidedLive, RequestContextStorageLive)),
);
const AppLive = Layer.mergeAll(
  AppConfigLive,
  RequestContextStorageLive,
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
  const app = new Hono<AppEnv>();

  app.use('*', cors(), logger(), makeRequestContextMiddleware(requestStorage));
  app.route('/auth', authRoutes);
  app.route('/user', userRoutes);
  app.route('/todo', todoRoutes);
  app.route('/storage', storageRoutes);
  app.notFound(notFound);
  app.onError(errorHandler);

  return app;
});

export const app = await appRuntime.runPromise(makeApp);
export const config = await appRuntime.runPromise(AppConfig);
export const disposeApp = () => appRuntime.dispose();
