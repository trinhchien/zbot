import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import pg from 'pg';
import { env } from '@reunion/shared/config/env';
import { logger } from '@reunion/shared/logger';

let _checkpointer: PostgresSaver | undefined;
let _pool: pg.Pool | undefined;

export async function getCheckpointer(): Promise<PostgresSaver> {
  if (_checkpointer) return _checkpointer;

  _pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: 5,
  });

  // TODO(human): PostgresSaver constructor may differ in installed version.
  // Check node_modules/@langchain/langgraph-checkpoint-postgres for actual API.
  _checkpointer = new PostgresSaver(_pool);
  await _checkpointer.setup();
  logger.info('LangGraph PostgresSaver initialized');

  return _checkpointer;
}

export async function closeCheckpointer(): Promise<void> {
  await _pool?.end();
  _checkpointer = undefined;
  _pool = undefined;
}
