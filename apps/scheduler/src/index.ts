import { logger } from '@reunion/shared/logger';

// Scheduler — full implementation in M2+
// Stub for M0 bootstrap

logger.info('Scheduler started (stub — cron jobs will be added in M2+)');

process.on('SIGTERM', () => {
  logger.info('Scheduler shutting down');
  process.exit(0);
});
