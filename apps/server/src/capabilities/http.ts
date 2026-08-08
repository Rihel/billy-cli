import { zValidator } from '@hono/zod-validator';
import { AppErrorCodes, ResponseUtils, parseZodIssues } from '@repo/shared';
import { Context as EffectContext, Layer } from 'effect';
import type { Context, Env } from 'hono';
import type { ZodType } from 'zod';

type ErrorHttpStatus = 400 | 401 | 403 | 404 | 409 | 500;

export interface ErrorDescriptor {
  value: number;
  http: ErrorHttpStatus;
  label: string;
}

export type AppEnv = { Variables: Record<string, never> };

const toErrorHttpStatus = (status: unknown): ErrorHttpStatus => {
  switch (status) {
    case 400:
    case 401:
    case 403:
    case 404:
    case 409:
    case 500:
      return status;
    default:
      return 500;
  }
};

export const describeErrorCode = (code: number): ErrorDescriptor => {
  const descriptor = AppErrorCodes.getOption(code);
  return descriptor
    ? {
        value: Number(descriptor.value),
        http: toErrorHttpStatus(descriptor.http),
        label: String(descriptor.label),
      }
    : { value: 5001, http: 500, label: '系统错误' };
};

const errorByTag: Record<string, ErrorDescriptor> = {
  EmailNotFoundError: describeErrorCode(AppErrorCodes.EmailNotFound),
  EmailTakenError: describeErrorCode(AppErrorCodes.EmailTaken),
  InvalidCredentialsError: describeErrorCode(AppErrorCodes.InvalidCredentials),
  InvalidResetTokenError: describeErrorCode(AppErrorCodes.InvalidResetToken),
  ExpiredResetTokenError: describeErrorCode(AppErrorCodes.ExpiredResetToken),
  InvalidTokenError: describeErrorCode(AppErrorCodes.TokenInvalid),
  InvalidOldPasswordError: describeErrorCode(AppErrorCodes.InvalidOldPassword),
  PasswordUnchangedError: describeErrorCode(AppErrorCodes.PasswordUnchanged),
  UserNotFoundError: describeErrorCode(AppErrorCodes.UserNotFound),
  TodoNotFoundError: describeErrorCode(AppErrorCodes.TodoNotFound),
};

const infrastructureTags = new Set([
  'DbError',
  'PasswordHashingError',
  'TokenSigningError',
  'RedisStoreError',
  'ObjectStorageError',
]);

export const mapError = (error: unknown): ErrorDescriptor => {
  if (error && typeof error === 'object' && '_tag' in error) {
    const tag = String(error._tag);
    const descriptor = errorByTag[tag];
    if (descriptor) return descriptor;
    if (infrastructureTags.has(tag)) {
      return describeErrorCode(AppErrorCodes.Internal);
    }
  }
  return describeErrorCode(AppErrorCodes.Internal);
};

export interface HttpApi {
  readonly jsonBody: typeof jsonBody;
  readonly success: typeof success;
}

export class Http extends EffectContext.Tag('app/Http')<Http, HttpApi>() {}

export const jsonBody = <Schema extends ZodType>(schema: Schema) =>
  zValidator('json', schema, (result, context) => {
    if (result.success) return;
    return context.json(
      ResponseUtils.error(400, parseZodIssues(result.error.issues)),
      200,
    );
  });

export const success = <E extends Env, T>(context: Context<E>, data: T) =>
  context.json(ResponseUtils.success(data), 200);

export const http: HttpApi = { jsonBody, success };
export const HttpLive = Layer.succeed(Http, http);

export const errorHandler = (error: Error, context: Context) => {
  const descriptor = mapError(error);
  console.error('request failed', error);
  return context.json(
    ResponseUtils.error(descriptor.value, descriptor.label),
    descriptor.http,
  );
};

export const notFound = (context: Context<AppEnv>) =>
  context.json(ResponseUtils.error(404, '接口不存在'), 404);
