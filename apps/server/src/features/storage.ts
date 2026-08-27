import { ObjectStorage } from '@repo/kits';
import type { AppContext } from '@repo/di';
import {
  GetStorageDownloadUrlSchema,
  GetStorageUploadPresignedUrlSchema,
} from '@repo/shared';
import { Hono } from 'hono';
import { makeRequireAdminAuth } from '../lib/authentication.js';
import { jsonBody, success } from '../lib/http.js';
import { requestContext } from '../lib/request-context.js';

export const makeStorageRoutes = (runtime: AppContext) => {
  const storage = runtime.get(ObjectStorage);
  const requireAdminAuth = makeRequireAdminAuth(runtime);
  const routes = new Hono();

  routes.use('*', requireAdminAuth);
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
      const adminId = requestContext.get('adminId');
      if (!adminId) {
        throw new Error('Authenticated admin request context is unavailable');
      }
      return success(
        context,
        await storage.getTemporaryCredentials({ userId: adminId }),
      );
    });

  return routes;
};
