import { Worker } from 'bullmq';
import { getRedisConnection, QUEUE_INBOUND, type InboundJob } from '@reunion/shared/queue';
import { logger } from '@reunion/shared/logger';
import { processInbound } from './pipeline/preprocess';

const worker = new Worker<InboundJob>(
  QUEUE_INBOUND,
  async (job) => {
    const start = Date.now();
    try {
      await processInbound(job.data.message);
      logger.info(
        {
          jobId: job.id,
          platform: job.data.message.platform,
          durMs: Date.now() - start,
        },
        'Processed inbound message',
      );
    } catch (e) {
      logger.error({ err: e, jobId: job.id }, 'Failed to process inbound');
      throw e;
    }
  },
  {
    ...getRedisConnection(),
    concurrency: 3,
    limiter: { max: 30, duration: 60_000 },
  },
);

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'Job failed');
});

logger.info('Bot core worker started');

process.on('SIGTERM', async () => {
  await worker.close();
  process.exit(0);
});
