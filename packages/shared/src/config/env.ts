import { z } from 'zod';
import 'dotenv/config';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  TZ: z.string().default('Asia/Ho_Chi_Minh'),

  DATABASE_URL: z.string().url(),
  DATABASE_MAX_POOL: z.coerce.number().default(10),

  REDIS_URL: z.string().url(),
  REDIS_PREFIX: z.string().default('reunion:'),

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL_PRIMARY: z.string().default('gemini-2.5-flash'),
  GEMINI_MODEL_LITE: z.string().default('gemini-2.5-flash-lite'),
  GEMINI_MODEL_EMBED: z.string().default('text-embedding-004'),
  GEMINI_DAILY_REQUEST_BUDGET: z.coerce.number().default(200),
  GEMINI_LITE_DAILY_BUDGET: z.coerce.number().default(800),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  TELEGRAM_ALLOWED_CHAT_IDS: z.string().default(''),

  ZALO_ENABLED: z.coerce.boolean().default(false),
  ZALO_CREDENTIALS_PATH: z.string().default('/data/zalo/credentials.enc'),
  ZALO_CREDENTIALS_KEY: z.string().optional(),
  ZALO_ALLOWED_GROUP_IDS: z.string().default(''),

  BOT_DISPLAY_NAME: z.string().default('Trợ lý Lớp'),
  PRIMARY_EVENT_NAME: z.string().default('Họp lớp 10 năm 2/9'),
  PRIMARY_EVENT_DATE: z.string().default('2025-09-02T11:00:00+07:00'),
  ORGANIZER_TELEGRAM_IDS: z.string().default(''),
  ORGANIZER_ZALO_IDS: z.string().default(''),
  TREASURER_USER_IDS: z.string().default(''),

  BACKUP_RCLONE_REMOTE: z.string().optional(),
  BACKUP_RETENTION_DAYS: z.coerce.number().default(30),

  // LangSmith (optional)
  LANGSMITH_TRACING: z.coerce.boolean().default(false),
  LANGSMITH_API_KEY: z.string().optional(),
  LANGSMITH_PROJECT: z.string().default('reunion-bot'),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
