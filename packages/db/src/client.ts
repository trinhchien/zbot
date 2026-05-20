import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { env } from '@reunion/shared/config/env';
import * as schema from './schema/index';

const queryClient = postgres(env.DATABASE_URL, {
  max: env.DATABASE_MAX_POOL,
  prepare: false,
});

export const db = drizzle(queryClient, { schema });
export type DB = typeof db;
