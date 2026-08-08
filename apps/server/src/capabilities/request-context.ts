import { AsyncLocalStorage } from 'node:async_hooks';
import { Context, Layer } from 'effect';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from './http.js';

export interface RequestContextData {
  userId: string | null;
}

export interface RequestContextApi {
  readonly userId: string | null;
}

export interface RequestContextStorageApi {
  run<Result>(store: RequestContextData, callback: () => Result): Result;
  getStore(): RequestContextData | undefined;
  get<Key extends keyof RequestContextData>(
    key: Key,
  ): RequestContextData[Key] | undefined;
  set<Key extends keyof RequestContextData>(
    key: Key,
    value: RequestContextData[Key],
  ): void;
}

export class RequestContext extends Context.Tag('app/RequestContext')<
  RequestContext,
  RequestContextApi
>() {}

export class RequestContextStorage extends Context.Tag(
  'app/RequestContextStorage',
)<RequestContextStorage, RequestContextStorageApi>() {}

const storage = new AsyncLocalStorage<RequestContextData>();

export const requestContext: RequestContextStorageApi = {
  run<Result>(store: RequestContextData, callback: () => Result): Result {
    return storage.run(store, callback);
  },
  getStore(): RequestContextData | undefined {
    return storage.getStore();
  },
  get<Key extends keyof RequestContextData>(
    key: Key,
  ): RequestContextData[Key] | undefined {
    return storage.getStore()?.[key];
  },
  set<Key extends keyof RequestContextData>(
    key: Key,
    value: RequestContextData[Key],
  ): void {
    const store = storage.getStore();
    if (store) store[key] = value;
  },
};

export const RequestContextStorageLive = Layer.succeed(
  RequestContextStorage,
  requestContext,
);

export const makeRequestContextMiddleware = (
  requestStorage: RequestContextStorageApi,
) =>
  createMiddleware<AppEnv>(async (_context, next) =>
    requestStorage.run({ userId: null }, next),
  );
