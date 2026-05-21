import { Worker } from 'bullmq';
import { getRedisConnection, QUEUE_INBOUND, QUEUE_JOBS, type InboundJob, type BackgroundJob } from '@reunion/shared/queue';
import { logger } from '@reunion/shared/logger';
import { env } from '@reunion/shared/config/env';
import { db } from '@reunion/db/client';
import { events, messages as messagesTable } from '@reunion/db/schema';
import { eq } from 'drizzle-orm';
import { processInbound } from './pipeline/preprocess';
import { embed } from './services/embedding';
import { updateMessageEmbedding, markMessageEmbeddingFailed } from '@reunion/db/repositories/memory';

async function bootstrapPrimaryEvent() {
  const existing = await db.select().from(events).limit(1);
  if (existing.length > 0 && existing[0]) {
    logger.info({ name: existing[0].name }, 'Primary event already exists');
    return;
  }
  const [created] = await db
    .insert(events)
    .values({
      name: env.PRIMARY_EVENT_NAME,
      eventDate: new Date(env.PRIMARY_EVENT_DATE),
      status: 'planning',
    })
    .returning();
  if (created) {
    logger.info({ id: created.id, name: created.name }, 'Bootstrapped primary event');
  }
}

async function main() {
  await bootstrapPrimaryEvent();

  // Inbound message worker
  const inboundWorker = new Worker<InboundJob>(
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

  inboundWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Inbound job failed');
  });

  // Background jobs worker (embed-batch, etc.)
  const bgWorker = new Worker<BackgroundJob>(
    QUEUE_JOBS,
    async (job) => {
      if (job.data.type === 'embed-batch') {
        const { messageId } = (job.data.payload ?? {}) as { messageId?: string };
        if (!messageId) return;

        const [msg] = await db
          .select({ id: messagesTable.id, content: messagesTable.content, status: messagesTable.embeddingStatus })
          .from(messagesTable)
          .where(eq(messagesTable.id, messageId));

        if (!msg || !msg.content || msg.status !== 'pending') return;

        try {
          const [embedding] = await embed([msg.content]);
          if (embedding && embedding.length > 0) {
            await updateMessageEmbedding(messageId, embedding);
            logger.debug({ messageId }, 'Message embedding done');
          }
        } catch (e) {
          await markMessageEmbeddingFailed(messageId);
          logger.warn({ err: e, messageId }, 'Message embedding failed');
        }
      }
    },
    {
      ...getRedisConnection(),
      concurrency: 2,
    },
  );

  bgWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, type: job?.data.type, err }, 'Background job failed');
  });

  logger.info('Bot core worker started');

  process.on('SIGTERM', async () => {
    await inboundWorker.close();
    await bgWorker.close();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error({ err }, 'Bot core failed to start');
  process.exit(1);
});
