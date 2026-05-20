import IORedis from 'ioredis';
import { env } from '@reunion/shared/config/env';

const redis = new IORedis(env.REDIS_URL);

export type ModelTier = 'primary' | 'lite' | 'embedding';

const BUDGETS: Record<ModelTier, number> = {
  primary: env.GEMINI_DAILY_REQUEST_BUDGET,
  lite: env.GEMINI_LITE_DAILY_BUDGET,
  embedding: 1400,
};

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Atomic check-and-increment using Redis.
 * Returns true if request was within budget (and counter incremented).
 */
export async function checkAndConsume(tier: ModelTier): Promise<boolean> {
  const key = `${env.REDIS_PREFIX}quota:${tier}:${dayKey()}`;
  const used = await redis.incr(key);
  if (used === 1) {
    await redis.expire(key, 60 * 60 * 30);
  }
  return used <= BUDGETS[tier];
}

export async function getUsage(): Promise<Record<ModelTier, number>> {
  const day = dayKey();
  const [p, l, e] = await Promise.all([
    redis.get(`${env.REDIS_PREFIX}quota:primary:${day}`),
    redis.get(`${env.REDIS_PREFIX}quota:lite:${day}`),
    redis.get(`${env.REDIS_PREFIX}quota:embedding:${day}`),
  ]);
  return {
    primary: Number(p ?? 0),
    lite: Number(l ?? 0),
    embedding: Number(e ?? 0),
  };
}
