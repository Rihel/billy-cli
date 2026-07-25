export const appConfig = {
  isDev: process.env.NODE_ENV !== 'production',
  dbUrl: process.env.DB_URL!,
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379/0',
  port: 9989,
  jwtSecret: process.env.JWT_SECRET ?? 'default-secret-change-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  resetPasswordTokenTtlMinutes: 30,
  storage: {
    provider: 's3',
    region: 'us-east-1',
    bucket: 'billy-cli',
    accessKeyId: 'minioadmin',
    secretAccessKey: 'minioadmin',
    endpoint: 'http://localhost:9000',
  },
};
