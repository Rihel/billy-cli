export const appConfig = {
  dbUrl: process.env.DB_URL!,
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379/0',
  port: 9989,
  jwtSecret: process.env.JWT_SECRET ?? 'default-secret-change-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  resetPasswordTokenTtlMinutes: 30,
};
