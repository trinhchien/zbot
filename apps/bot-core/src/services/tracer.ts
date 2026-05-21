import { CallbackHandler } from 'langfuse-langchain';
import { env } from '@reunion/shared/config/env';
import { logger } from '@reunion/shared/logger';

let _handler: CallbackHandler | undefined;

/**
 * Returns a Langfuse CallbackHandler if LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY are set.
 * Returns undefined when tracing is disabled — callers can spread into callbacks array safely.
 */
export function getTracer(): CallbackHandler | undefined {
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return undefined;

  if (!_handler) {
    _handler = new CallbackHandler({
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: env.LANGFUSE_SECRET_KEY,
      baseUrl: env.LANGFUSE_HOST,
    });
    logger.info({ host: env.LANGFUSE_HOST }, 'Langfuse tracing enabled');
  }

  return _handler;
}
