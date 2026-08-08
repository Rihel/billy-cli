import type { RuntimeConfigInput } from '@repo/core';
import { Context, Layer } from 'effect';

export interface AppConfigApi {
  readonly isDev: boolean;
  readonly port: number;
  readonly core: RuntimeConfigInput;
}

export class AppConfig extends Context.Tag('app/AppConfig')<
  AppConfig,
  AppConfigApi
>() {}

const isDev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 9989);

export const appConfig: AppConfigApi = {
  isDev,
  port,
  core: {
    isDev,
    port,
    db: {
      url:
        process.env.DB_URL ??
        'postgres://postgres:postgres@localhost:5432/postgres',
    },
    redis: { url: process.env.REDIS_URL ?? 'redis://localhost:6379/0' },
    jwt: {
      secret: process.env.JWT_SECRET ?? 'default-secret-change-in-production',
      expiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
    },
    auth: { resetPasswordTokenTtlMinutes: 30 },
    objectStorage: {
      provider: (process.env.OBJECT_STORAGE_PROVIDER ?? 's3') as 's3' | 'cos',
      region: process.env.OBJECT_STORAGE_REGION ?? 'us-east-1',
      bucket: process.env.OBJECT_STORAGE_BUCKET ?? 'billy-cli',
      accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID ?? 'minioadmin',
      secretAccessKey:
        process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY ?? 'minioadmin',
      endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://localhost:9000',
    },
    logger: { name: 'server', pretty: isDev },
  },
};

export const AppConfigLive = Layer.succeed(AppConfig, appConfig);
