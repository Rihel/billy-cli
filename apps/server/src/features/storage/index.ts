import {
  ObjectKey,
  ObjectStorage,
  TemporaryCredentialsRequest,
  UploadObject,
} from '@repo/core';
import {
  GetStorageDownloadUrlSchema,
  GetStorageUploadPresignedUrlSchema,
} from '@repo/shared';
import { Effect } from 'effect';
import { Hono } from 'hono';
import { Authentication } from '../../capabilities/authentication.js';
import { EffectExecutor } from '../../capabilities/effect-executor.js';
import { Http, type AppEnv } from '../../capabilities/http.js';
import { RequestContext } from '../../capabilities/request-context.js';

export const makeStorageRoutes = Effect.gen(function* () {
  const executor = yield* EffectExecutor;
  const { jsonBody, success } = yield* Http;
  const { requireAuth } = yield* Authentication;
  const routes = new Hono<AppEnv>();

  routes.use('*', requireAuth);
  routes
    .post(
      '/get-presigned-url',
      jsonBody(GetStorageUploadPresignedUrlSchema),
      async (context) => {
        const input = context.req.valid('json');
        const result = await executor.run(
          Effect.gen(function* () {
            const storage = yield* ObjectStorage;
            return yield* storage.getPresignedUrl(new UploadObject(input));
          }),
        );
        return success(context, result);
      },
    )
    .post(
      '/get-download-url',
      jsonBody(GetStorageDownloadUrlSchema),
      async (context) => {
        const input = context.req.valid('json');
        const result = await executor.run(
          Effect.gen(function* () {
            const storage = yield* ObjectStorage;
            return yield* storage.getDownloadUrl(new ObjectKey(input));
          }),
        );
        return success(context, result);
      },
    )
    .post('/get-temporary-credentials', async (context) => {
      const result = await executor.run(
        Effect.gen(function* () {
          const storage = yield* ObjectStorage;
          const request = yield* RequestContext;
          if (!request.userId) {
            throw new Error('Authenticated request context is unavailable');
          }
          return yield* storage.getTemporaryCredentials(
            new TemporaryCredentialsRequest({ userId: request.userId }),
          );
        }),
      );
      return success(context, result);
    });

  return routes;
});
