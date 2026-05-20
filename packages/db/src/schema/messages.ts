import { pgTable, uuid, text, timestamp, jsonb, boolean, vector, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { userIdentities } from './users';

export const chatGroups = pgTable(
  'chat_groups',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    platform: text('platform', { enum: ['telegram', 'zalo', 'messenger'] }).notNull(),
    platformChatId: text('platform_chat_id').notNull(),
    name: text('name'),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqPlatformChat: unique('uniq_platform_chat').on(t.platform, t.platformChatId),
  }),
);

export interface Attachment {
  type: 'image' | 'file' | 'audio' | 'video' | 'sticker';
  url?: string;
  mimeType?: string;
  fileName?: string;
  size?: number;
}

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    chatGroupId: uuid('chat_group_id')
      .references(() => chatGroups.id, { onDelete: 'cascade' })
      .notNull(),
    platform: text('platform', { enum: ['telegram', 'zalo', 'messenger'] }).notNull(),
    platformMessageId: text('platform_message_id').notNull(),
    senderIdentityId: uuid('sender_identity_id').references(() => userIdentities.id),
    content: text('content'),
    messageType: text('message_type', {
      enum: ['text', 'image', 'file', 'sticker', 'system', 'bot'],
    })
      .notNull()
      .default('text'),
    attachments: jsonb('attachments').$type<Attachment[]>().default([]),
    replyToMessageId: uuid('reply_to_message_id'),
    mentions: jsonb('mentions').$type<string[]>().default([]),
    botMentioned: boolean('bot_mentioned').notNull().default(false),
    embedding: vector('embedding', { dimensions: 768 }),
    embeddingStatus: text('embedding_status', { enum: ['pending', 'done', 'failed'] })
      .notNull()
      .default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqPlatformMsg: unique('uniq_platform_msg').on(t.platform, t.platformMessageId),
    byChatTime: index('idx_msg_chat_time').on(t.chatGroupId, t.createdAt),
    bySender: index('idx_msg_sender').on(t.senderIdentityId),
    embeddingIdx: index('idx_msg_embedding')
      .using('hnsw', t.embedding.op('vector_cosine_ops'))
      .where(sql`embedding IS NOT NULL`),
  }),
);
