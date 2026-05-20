import { pgTable, uuid, text, timestamp, jsonb, bigint, integer, primaryKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { messages } from './messages';

export const events = pgTable('events', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  description: text('description'),
  eventDate: timestamp('event_date', { withTimezone: true }),
  location: text('location'),
  status: text('status', { enum: ['planning', 'confirmed', 'done', 'cancelled'] })
    .notNull()
    .default('planning'),
  budgetTotal: bigint('budget_total', { mode: 'number' }).notNull().default(0),
  createdByUserId: uuid('created_by_user_id').references(() => users.id),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const eventDecisions = pgTable('event_decisions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  eventId: uuid('event_id')
    .references(() => events.id, { onDelete: 'cascade' })
    .notNull(),
  topic: text('topic').notNull(),
  decision: text('decision').notNull(),
  decidedByUserId: uuid('decided_by_user_id').references(() => users.id),
  sourceMessageId: uuid('source_message_id').references(() => messages.id),
  supersededBy: uuid('superseded_by'),
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
});

export const eventParticipants = pgTable(
  'event_participants',
  {
    eventId: uuid('event_id')
      .references(() => events.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    rsvpStatus: text('rsvp_status', { enum: ['yes', 'no', 'maybe', 'pending'] })
      .notNull()
      .default('pending'),
    plusOnes: integer('plus_ones').notNull().default(0),
    notes: text('notes'),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.eventId, t.userId] }),
  }),
);
