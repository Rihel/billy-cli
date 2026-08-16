import { ObjectStorage, appCore } from '@repo/core';
import {
  GetStorageDownloadUrlSchema,
  GetStorageUploadPresignedUrlSchema,
} from '@repo/shared';
import { Hono } from 'hono';
import { requireAuth } from '../lib/authentication.js';
import { jsonBody, success } from '../lib/http.js';
import { requestContext } from '../lib/request-context.js';

export const makeStorageRoutes = () => {
  const storage = appCore.get(ObjectStorage);
  const routes = new Hono();

  routes.use('*', requireAuth);
  routes
    .post(
      '/get-presigned-url',
      jsonBody(GetStorageUploadPresignedUrlSchema),
      async (context) => {
        const input = context.req.valid('json');
        return success(
          context,
          await storage.getPresignedUrl(input),
        );
      },
    )
    .post(
      '/get-download-url',
      jsonBody(GetStorageDownloadUrlSchema),
      async (context) => {
        const input = context.req.valid('json');
        return success(
          context,
          await storage.getDownloadUrl(input),
        );
      },
    )
    .post('/get-temporary-credentials', async (context) => {
      const userId = requestContext.get('userId');
      if (!userId) {
        throw new Error('Authenticated request context is unavailable');
      }
      return success(
        context,
        await storage.getTemporaryCredentials({ userId }),
      );
    });

  return routes;
};
