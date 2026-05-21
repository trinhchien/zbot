import { db } from '../client';
import { tasks } from '../schema';
import { users } from '../schema';
import { eq, and, desc, isNull, sql } from 'drizzle-orm';

type TaskStatus = 'todo' | 'doing' | 'done' | 'blocked' | 'cancelled';
type TaskPriority = 'low' | 'normal' | 'high';

// Priority sort: high=1, normal=2, low=3
const priorityOrder = sql`CASE ${tasks.priority} WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`;

export async function createTask(opts: {
  title: string;
  description?: string;
  eventId?: string;
  assigneeUserId?: string;
  dueDate?: Date;
  priority?: TaskPriority;
  createdByUserId?: string;
}) {
  const [task] = await db
    .insert(tasks)
    .values({
      title: opts.title,
      description: opts.description ?? null,
      eventId: opts.eventId ?? null,
      assigneeUserId: opts.assigneeUserId ?? null,
      dueDate: opts.dueDate ?? null,
      priority: opts.priority ?? 'normal',
      createdByUserId: opts.createdByUserId ?? null,
      status: 'todo',
    })
    .returning();
  return task!;
}

export async function assignTask(taskId: string, assigneeUserId: string) {
  const [updated] = await db
    .update(tasks)
    .set({ assigneeUserId, updatedAt: new Date() })
    .where(eq(tasks.id, taskId))
    .returning();
  return updated ?? null;
}

export async function updateTaskStatus(taskId: string, status: TaskStatus) {
  const [updated] = await db
    .update(tasks)
    .set({ status, updatedAt: new Date() })
    .where(eq(tasks.id, taskId))
    .returning();
  return updated ?? null;
}

export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueDate: Date | null;
  eventId: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  assigneeNickname: string | null;
  createdAt: Date;
}

export async function listTasks(opts: {
  assigneeUserId?: string;
  unassignedOnly?: boolean;
  eventId?: string;
  status?: TaskStatus;
  excludeStatuses?: TaskStatus[];
  limit?: number;
}): Promise<TaskRow[]> {
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      priority: tasks.priority,
      dueDate: tasks.dueDate,
      eventId: tasks.eventId,
      assigneeUserId: tasks.assigneeUserId,
      assigneeName: users.canonicalName,
      assigneeNickname: users.nickname,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .leftJoin(users, eq(tasks.assigneeUserId, users.id))
    .where(
      and(
        opts.assigneeUserId ? eq(tasks.assigneeUserId, opts.assigneeUserId) : undefined,
        opts.unassignedOnly ? isNull(tasks.assigneeUserId) : undefined,
        opts.eventId ? eq(tasks.eventId, opts.eventId) : undefined,
        opts.status ? eq(tasks.status, opts.status) : undefined,
      ),
    )
    .orderBy(priorityOrder, tasks.dueDate, desc(tasks.createdAt))
    .limit(opts.limit ?? 20);

  return rows;
}

export async function getTaskById(taskId: string): Promise<TaskRow | null> {
  const [row] = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      priority: tasks.priority,
      dueDate: tasks.dueDate,
      eventId: tasks.eventId,
      assigneeUserId: tasks.assigneeUserId,
      assigneeName: users.canonicalName,
      assigneeNickname: users.nickname,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .leftJoin(users, eq(tasks.assigneeUserId, users.id))
    .where(eq(tasks.id, taskId));
  return row ?? null;
}
