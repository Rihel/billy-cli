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
  // -- Set 操作

  sadd(key: string, ...members: string[]): Promise<number> {
    return this.redis.sadd(key, ...members);
  }

  srem(key: string, ...members: string[]): Promise<number> {
    return this.redis.srem(key, ...members);
  }

  smembers(key: string): Promise<string[]> {
    return this.redis.smembers(key);
  }

  sismember(key: string, member: string): Promise<number> {
    return this.redis.sismember(key, member);
  }

  scard(key: string): Promise<number> {
    return this.redis.scard(key);
  }

  // ── List 操作 ─────────────────────────────────────────

  lpush(key: string, ...values: string[]): Promise<number> {
    return this.redis.lpush(key, ...values);
  }

  rpush(key: string, ...values: string[]): Promise<number> {
    return this.redis.rpush(key, ...values);
  }

  lpop(key: string): Promise<string | null> {
    return this.redis.lpop(key);
  }

  rpop(key: string): Promise<string | null> {
    return this.redis.rpop(key);
  }

  lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.redis.lrange(key, start, stop);
  }

  llen(key: string): Promise<number> {
    return this.redis.llen(key);
  }

  lrem(key: string, count: number, value: string): Promise<number> {
    return this.redis.lrem(key, count, value);
  }

  lindex(key: string, index: number): Promise<string | null> {
    return this.redis.lindex(key, index);
  }

  lset(key: string, index: number, value: string): Promise<'OK'> {
    return this.redis.lset(key, index, value);
  }

  ltrim(key: string, start: number, stop: number): Promise<'OK'> {
    return this.redis.ltrim(key, start, stop);
  }

  // -- Locking (分布式锁) ───────────────────────────────────

  async acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(key, 'locked', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async releaseLock(key: string): Promise<void> {
    await this.redis.del(key);
  }

  // -- Pub/Sub ─────────────────────────────────────────────

  publish(channel: string, message: string): Promise<number> {
    return this.redis.publish(channel, message);
  }

  subscribe(channel: string, listener: (message: string) => void): void {
    const subscriber = new Redis(this.redis.options);
    subscriber.subscribe(channel, (err) => {
      if (err) {
        console.error('Failed to subscribe:', err);
        return;
      }
      subscriber.on('message', (chan, msg) => {
        if (chan === channel) {
          listener(msg);
        }
      });
    });
  }

  unsubscribe(channel: string): void {
    const subscriber = new Redis(this.redis.options);
    subscriber.unsubscribe(channel, (err) => {
      if (err) {
        console.error('Failed to unsubscribe:', err);
      }
      subscriber.quit();
    });
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
