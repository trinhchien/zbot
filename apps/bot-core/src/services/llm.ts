import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { env } from '@reunion/shared/config/env';
import { checkAndConsume, type ModelTier } from './rate-limit';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';

/**
 * Callback to enforce rate limit BEFORE the call is made.
 */
class RateLimitCallback extends BaseCallbackHandler {
  name = 'rate-limit';
  private tier: ModelTier;

  constructor(tier: ModelTier) {
    super();
    this.tier = tier;
  }

  async handleLLMStart() {
    const allowed = await checkAndConsume(this.tier);
    if (!allowed) {
      throw new QuotaExceededError(`Gemini ${this.tier} daily budget exhausted`);
    }
  }
}

export class QuotaExceededError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'QuotaExceededError';
  }
}

interface LLMOptions {
  tier: 'primary' | 'lite';
  temperature?: number;
}

export function buildLLM(opts: LLMOptions): ChatGoogleGenerativeAI {
  const model = opts.tier === 'primary' ? env.GEMINI_MODEL_PRIMARY : env.GEMINI_MODEL_LITE;
  return new ChatGoogleGenerativeAI({
    model,
    apiKey: env.GEMINI_API_KEY,
    temperature: opts.temperature ?? 0.4,
    maxRetries: 2,
    callbacks: [new RateLimitCallback(opts.tier)],
  });
}
