import { InjectRedis } from '@nestjs-modules/ioredis';
import { Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';

@Injectable()
export class RedisService {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  // ── 基础 ─────────────────────────────────────────────

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  set(key: string, value: string, ttlSeconds?: number): Promise<'OK'> {
    if (ttlSeconds != null) return this.redis.set(key, value, 'EX', ttlSeconds);
    return this.redis.set(key, value);
  }

  del(...keys: string[]): Promise<number> {
    return this.redis.del(...keys);
  }

  exists(...keys: string[]): Promise<number> {
    return this.redis.exists(...keys);
  }

  expire(key: string, seconds: number): Promise<number> {
    return this.redis.expire(key, seconds);
  }

  ttl(key: string): Promise<number> {
    return this.redis.ttl(key);
  }

  incr(key: string): Promise<number> {
    return this.redis.incr(key);
  }

  incrby(key: string, increment: number): Promise<number> {
    return this.redis.incrby(key, increment);
  }

  // ── Hash ─────────────────────────────────────────────

  hget(key: string, field: string): Promise<string | null> {
    return this.redis.hget(key, field);
  }

  hset(key: string, field: string, value: string): Promise<number> {
    return this.redis.hset(key, field, value);
  }

  hgetall(key: string): Promise<Record<string, string>> {
    return this.redis.hgetall(key);
  }

  hdel(key: string, ...fields: string[]): Promise<number> {
    return this.redis.hdel(key, ...fields);
  }

  // ── JSON 序列化辅助 ───────────────────────────────────

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (raw == null) return null;
    return JSON.parse(raw) as T;
  }

  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  // ── 原始实例（供复杂场景使用）────────────────────────

  get client(): Redis {
    return this.redis;
  }
}
