import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { NormalizedMessage, OutboundMessage } from './types/platform';

// Lazy initialization to avoid crashing on import when env is not loaded
let _redis: IORedis | undefined;

function getRedis(): IORedis {
  if (!_redis) {
    const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
    _redis = new IORedis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }
  return _redis;
}

export function getRedisConnection() {
  return {
    connection: getRedis(),
    prefix: process.env['REDIS_PREFIX'] ?? 'reunion:',
  };
}

export const QUEUE_INBOUND = 'inbound-messages';
export const QUEUE_OUTBOUND = 'outbound-messages';
export const QUEUE_JOBS = 'background-jobs';

// Job payloads
export interface InboundJob {
  message: NormalizedMessage;
}

export interface OutboundJob {
  message: OutboundMessage;
}

export interface BackgroundJob {
  type: 'embed-batch' | 'daily-digest' | 'remind-due-tasks' | 'remind-event' | 'backup';
  payload?: Record<string, unknown>;
}

// Lazy queue factories
let _inboundQueue: Queue<InboundJob> | undefined;
let _outboundQueue: Queue<OutboundJob> | undefined;
let _jobsQueue: Queue<BackgroundJob> | undefined;

export function getInboundQueue(): Queue<InboundJob> {
  if (!_inboundQueue) {
    _inboundQueue = new Queue<InboundJob>(QUEUE_INBOUND, { connection: getRedis(), prefix: process.env['REDIS_PREFIX'] ?? 'reunion:' });
  }
  return _inboundQueue;
}

export function getOutboundQueue(): Queue<OutboundJob> {
  if (!_outboundQueue) {
    _outboundQueue = new Queue<OutboundJob>(QUEUE_OUTBOUND, { connection: getRedis(), prefix: process.env['REDIS_PREFIX'] ?? 'reunion:' });
  }
  return _outboundQueue;
}

export function getJobsQueue(): Queue<BackgroundJob> {
  if (!_jobsQueue) {
    _jobsQueue = new Queue<BackgroundJob>(QUEUE_JOBS, { connection: getRedis(), prefix: process.env['REDIS_PREFIX'] ?? 'reunion:' });
  }
  return _jobsQueue;
}
