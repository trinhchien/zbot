import { pgTable, uuid, text, timestamp, bigint, boolean, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { events } from './events';

export const contributionCampaigns = pgTable('contribution_campaigns', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  eventId: uuid('event_id').references(() => events.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  amountPerHead: bigint('amount_per_head', { mode: 'number' }),
  deadline: timestamp('deadline', { withTimezone: true }),
  status: text('status', { enum: ['open', 'closed', 'cancelled'] }).notNull().default('open'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const contributions = pgTable(
  'contributions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    campaignId: uuid('campaign_id')
      .references(() => contributionCampaigns.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id')
      .references(() => users.id)
      .notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    paymentProof: text('payment_proof'),
    status: text('status', { enum: ['pending', 'verified', 'rejected'] }).notNull().default('pending'),
    verifiedByUserId: uuid('verified_by_user_id').references(() => users.id),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCampaignUser: index('idx_contrib_campaign_user').on(t.campaignId, t.userId),
    byStatus: index('idx_contrib_status').on(t.status),
  }),
);

export const expenses = pgTable(
  'expenses',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'cascade' }),
    description: text('description').notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    paidByUserId: uuid('paid_by_user_id').references(() => users.id),
    receipt: text('receipt'),
    category: text('category'),
    spentAt: timestamp('spent_at', { withTimezone: true }),
    approved: boolean('approved').notNull().default(false),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byEvent: index('idx_exp_event').on(t.eventId),
  }),
);
