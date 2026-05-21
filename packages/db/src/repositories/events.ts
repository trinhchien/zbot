import { db } from '../client';
import { events, eventDecisions, eventParticipants } from '../schema';
import { users } from '../schema';
import { desc, eq, sql } from 'drizzle-orm';

export async function getPrimaryEvent() {
  const [e] = await db.select().from(events).orderBy(desc(events.createdAt)).limit(1);
  return e ?? null;
}

export async function getRsvpCounts(eventId: string) {
  const rows = await db
    .select({
      status: eventParticipants.rsvpStatus,
      count: sql<number>`count(*)::int`,
    })
    .from(eventParticipants)
    .where(eq(eventParticipants.eventId, eventId))
    .groupBy(eventParticipants.rsvpStatus);

  const counts: Record<string, number> = { yes: 0, no: 0, maybe: 0, pending: 0 };
  for (const r of rows) {
    counts[r.status] = r.count;
  }
  return counts;
}

export async function upsertRsvp(
  eventId: string,
  userId: string,
  status: 'yes' | 'no' | 'maybe',
  extras?: { plusOnes?: number; notes?: string },
) {
  await db
    .insert(eventParticipants)
    .values({
      eventId,
      userId,
      rsvpStatus: status,
      respondedAt: new Date(),
      plusOnes: extras?.plusOnes ?? 0,
      notes: extras?.notes ?? null,
    })
    .onConflictDoUpdate({
      target: [eventParticipants.eventId, eventParticipants.userId],
      set: {
        rsvpStatus: status,
        respondedAt: new Date(),
        ...(extras?.plusOnes !== undefined && { plusOnes: extras.plusOnes }),
        ...(extras?.notes !== undefined && { notes: extras.notes }),
      },
    });
}

// ===== Event mutations =====

export async function createEvent(opts: {
  name: string;
  description?: string;
  eventDate?: Date;
  location?: string;
  createdByUserId?: string;
}) {
  const [event] = await db
    .insert(events)
    .values({
      name: opts.name,
      description: opts.description ?? null,
      eventDate: opts.eventDate ?? null,
      location: opts.location ?? null,
      createdByUserId: opts.createdByUserId ?? null,
      status: 'planning',
    })
    .returning();
  return event!;
}

export async function updateEvent(
  eventId: string,
  patch: {
    name?: string;
    description?: string | null;
    eventDate?: Date | null;
    location?: string | null;
    status?: 'planning' | 'confirmed' | 'done' | 'cancelled';
    budgetTotal?: number;
  },
) {
  const [updated] = await db
    .update(events)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(events.id, eventId))
    .returning();
  return updated ?? null;
}

export async function insertEventDecision(opts: {
  eventId: string;
  topic: string;
  decision: string;
  decidedByUserId?: string;
  sourceMessageId?: string;
}) {
  const [row] = await db
    .insert(eventDecisions)
    .values({
      eventId: opts.eventId,
      topic: opts.topic,
      decision: opts.decision,
      decidedByUserId: opts.decidedByUserId ?? null,
      sourceMessageId: opts.sourceMessageId ?? null,
    })
    .returning();
  return row!;
}

export async function getEventDecisions(eventId: string) {
  return db
    .select()
    .from(eventDecisions)
    .where(eq(eventDecisions.eventId, eventId))
    .orderBy(desc(eventDecisions.decidedAt))
    .limit(20);
}

export async function getParticipantsWithNames(eventId: string) {
  const rows = await db
    .select({
      rsvpStatus: eventParticipants.rsvpStatus,
      canonicalName: users.canonicalName,
      nickname: users.nickname,
    })
    .from(eventParticipants)
    .innerJoin(users, eq(eventParticipants.userId, users.id))
    .where(eq(eventParticipants.eventId, eventId));

  return rows;
}
