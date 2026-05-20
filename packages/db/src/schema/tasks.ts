import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { events } from './events';

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    assigneeUserId: uuid('assignee_user_id').references(() => users.id),
    dueDate: timestamp('due_date', { withTimezone: true }),
    status: text('status', { enum: ['todo', 'doing', 'done', 'blocked', 'cancelled'] })
      .notNull()
      .default('todo'),
    priority: text('priority', { enum: ['low', 'normal', 'high'] }).notNull().default('normal'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byAssignee: index('idx_tasks_assignee').on(t.assigneeUserId, t.status),
    byEvent: index('idx_tasks_event').on(t.eventId, t.status),
    byDue: index('idx_tasks_due').on(t.dueDate),
  }),
);
