import { AsyncLocalStorage } from 'node:async_hooks';
import { createMiddleware } from 'hono/factory';

export interface RequestContextData {
  userId: string | null;
}


const storage = new AsyncLocalStorage<RequestContextData>();

export const requestContext = {
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

export const makeRequestContextMiddleware = (
  requestStorage: typeof requestContext,
) =>
  createMiddleware(async (_context, next) =>
    requestStorage.run({ userId: null }, next),
  );
