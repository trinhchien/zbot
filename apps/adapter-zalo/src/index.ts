import { logger } from '@reunion/shared/logger';

// Zalo adapter — full implementation in M6
// For now, just exit gracefully if not enabled

const zaloEnabled = process.env['ZALO_ENABLED'] === 'true';

if (!zaloEnabled) {
  logger.info('Zalo disabled by config, exiting.');
  process.exit(0);
}

logger.info('Zalo adapter stub — full implementation in M6');
// TODO(M6): implement ZaloAdapter with zca-js
