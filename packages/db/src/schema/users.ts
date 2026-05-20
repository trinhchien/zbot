import { pgTable, uuid, text, timestamp, jsonb, unique, vector, real, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  canonicalName: text('canonical_name').notNull(),
  nickname: text('nickname'),
  phone: text('phone'),
  email: text('email'),
  role: text('role', { enum: ['member', 'organizer', 'treasurer', 'admin'] })
    .notNull()
    .default('member'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const userIdentities = pgTable(
  'user_identities',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform', { enum: ['telegram', 'zalo', 'messenger'] }).notNull(),
    platformUserId: text('platform_user_id').notNull(),
    platformDisplayName: text('platform_display_name'),
    platformUsername: text('platform_username'),
    linkedAt: timestamp('linked_at', { withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqPlatformUser: unique('uniq_platform_user').on(t.platform, t.platformUserId),
    byUser: index('idx_identities_user').on(t.userId),
  }),
);

export const userFacts = pgTable(
  'user_facts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    fact: text('fact').notNull(),
    category: text('category', {
      enum: ['personal', 'preference', 'dietary', 'contact', 'role', 'commitment', 'other'],
    })
      .notNull()
      .default('other'),
    confidence: real('confidence').notNull().default(1.0),
    sourceMessageId: uuid('source_message_id'),
    embedding: vector('embedding', { dimensions: 768 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUserCategory: index('idx_facts_user_cat').on(t.userId, t.category),
    embeddingIdx: index('idx_facts_embedding').using('hnsw', t.embedding.op('vector_cosine_ops')),
  }),
);

export const linkCodes = pgTable('link_codes', {
  code: text('code').primaryKey(),
  userId: uuid('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
});
