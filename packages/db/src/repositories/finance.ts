import { db } from '../client';
import { contributionCampaigns, contributions, expenses, auditLog } from '../schema';
import { users } from '../schema';
import { eq, and, desc, sql } from 'drizzle-orm';

// ===== Campaigns =====

export async function createCampaign(opts: {
  name: string;
  eventId?: string;
  amountPerHead?: number;
  deadline?: Date;
  createdByUserId?: string;
}) {
  const [campaign] = await db
    .insert(contributionCampaigns)
    .values({
      name: opts.name,
      eventId: opts.eventId ?? null,
      amountPerHead: opts.amountPerHead ?? null,
      deadline: opts.deadline ?? null,
      createdByUserId: opts.createdByUserId ?? null,
      status: 'open',
    })
    .returning();
  return campaign!;
}

export async function getCampaigns(eventId?: string) {
  return db
    .select()
    .from(contributionCampaigns)
    .where(eventId ? eq(contributionCampaigns.eventId, eventId) : undefined)
    .orderBy(desc(contributionCampaigns.createdAt));
}

export async function getCampaignById(campaignId: string) {
  const [row] = await db
    .select()
    .from(contributionCampaigns)
    .where(eq(contributionCampaigns.id, campaignId));
  return row ?? null;
}

export async function getLatestOpenCampaign(eventId?: string) {
  const [row] = await db
    .select()
    .from(contributionCampaigns)
    .where(
      and(
        eq(contributionCampaigns.status, 'open'),
        eventId ? eq(contributionCampaigns.eventId, eventId) : undefined,
      ),
    )
    .orderBy(desc(contributionCampaigns.createdAt))
    .limit(1);
  return row ?? null;
}

// ===== Contributions =====

export async function recordContribution(opts: {
  campaignId: string;
  userId: string;
  amount: number;
  paymentProof?: string;
  paidAt?: Date;
}) {
  const [row] = await db
    .insert(contributions)
    .values({
      campaignId: opts.campaignId,
      userId: opts.userId,
      amount: opts.amount,
      paymentProof: opts.paymentProof ?? null,
      paidAt: opts.paidAt ?? new Date(),
      status: 'pending',
    })
    .returning();
  return row!;
}

export async function verifyContribution(opts: {
  contributionId: string;
  approved: boolean;
  note?: string;
  actorUserId: string;
  platform: string;
  messageId: string;
}): Promise<{ ok: boolean; error?: string; status?: string }> {
  // Read before state for audit log
  const [before] = await db
    .select()
    .from(contributions)
    .where(eq(contributions.id, opts.contributionId));

  if (!before) return { ok: false, error: 'Không tìm thấy đóng góp này' };
  if (before.status !== 'pending') {
    return {
      ok: false,
      error: `Đóng góp này đã ${before.status === 'verified' ? 'xác nhận' : 'từ chối'} rồi`,
    };
  }

  const newStatus = opts.approved ? 'verified' : 'rejected';

  const [after] = await db
    .update(contributions)
    .set({
      status: newStatus,
      verifiedByUserId: opts.actorUserId,
      verifiedAt: new Date(),
      note: opts.note ?? null,
    })
    .where(eq(contributions.id, opts.contributionId))
    .returning();

  // Immutable audit log entry
  await db.insert(auditLog).values({
    actorUserId: opts.actorUserId,
    actorType: 'user',
    action: opts.approved ? 'contribution.verify' : 'contribution.reject',
    entityType: 'contributions',
    entityId: opts.contributionId,
    before,
    after: after ?? null,
    context: { platform: opts.platform, messageId: opts.messageId },
  });

  return { ok: true, status: newStatus };
}

export interface ContributionRow {
  id: string;
  amount: number;
  status: string;
  paidAt: Date | null;
  paymentProof: string | null;
  note: string | null;
  verifiedAt: Date | null;
  userId: string;
  userName: string;
  userNickname: string | null;
}

export async function getContributions(campaignId: string): Promise<ContributionRow[]> {
  return db
    .select({
      id: contributions.id,
      amount: contributions.amount,
      status: contributions.status,
      paidAt: contributions.paidAt,
      paymentProof: contributions.paymentProof,
      note: contributions.note,
      verifiedAt: contributions.verifiedAt,
      userId: contributions.userId,
      userName: users.canonicalName,
      userNickname: users.nickname,
    })
    .from(contributions)
    .innerJoin(users, eq(contributions.userId, users.id))
    .where(eq(contributions.campaignId, campaignId))
    .orderBy(desc(contributions.createdAt));
}

export async function getUserContributions(userId: string, campaignId?: string) {
  return db
    .select({
      id: contributions.id,
      amount: contributions.amount,
      status: contributions.status,
      paidAt: contributions.paidAt,
      note: contributions.note,
      campaignId: contributions.campaignId,
      campaignName: contributionCampaigns.name,
    })
    .from(contributions)
    .innerJoin(
      contributionCampaigns,
      eq(contributions.campaignId, contributionCampaigns.id),
    )
    .where(
      and(
        eq(contributions.userId, userId),
        campaignId ? eq(contributions.campaignId, campaignId) : undefined,
      ),
    )
    .orderBy(desc(contributions.createdAt));
}

// ===== Expenses =====

export async function recordExpense(opts: {
  eventId?: string;
  description: string;
  amount: number;
  paidByUserId: string;
  receipt?: string;
  category?: string;
  spentAt?: Date;
}) {
  const [row] = await db
    .insert(expenses)
    .values({
      eventId: opts.eventId ?? null,
      description: opts.description,
      amount: opts.amount,
      paidByUserId: opts.paidByUserId,
      receipt: opts.receipt ?? null,
      category: opts.category ?? null,
      spentAt: opts.spentAt ?? new Date(),
      approved: true, // organizer-created expenses are self-approved
      approvedByUserId: opts.paidByUserId,
    })
    .returning();
  return row!;
}

export async function getExpenses(eventId?: string) {
  return db
    .select({
      id: expenses.id,
      description: expenses.description,
      amount: expenses.amount,
      category: expenses.category,
      spentAt: expenses.spentAt,
      approved: expenses.approved,
      paidByUserId: expenses.paidByUserId,
      paidByName: users.canonicalName,
      paidByNickname: users.nickname,
    })
    .from(expenses)
    .leftJoin(users, eq(expenses.paidByUserId, users.id))
    .where(eventId ? eq(expenses.eventId, eventId) : undefined)
    .orderBy(desc(expenses.spentAt));
}

// ===== Financial summary =====

export interface FinancialSummary {
  totalVerified: number;
  totalPending: number;
  totalExpenses: number;
  balance: number;
  countVerified: number;
  countPending: number;
  countRejected: number;
}

export async function financialSummary(campaignId?: string): Promise<FinancialSummary> {
  const whereClause = campaignId ? eq(contributions.campaignId, campaignId) : undefined;

  const [contribStats] = await db
    .select({
      totalVerified: sql<number>`COALESCE(SUM(CASE WHEN status = 'verified' THEN amount ELSE 0 END), 0)`,
      totalPending: sql<number>`COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0)`,
      countVerified: sql<number>`COUNT(CASE WHEN status = 'verified' THEN 1 END)`,
      countPending: sql<number>`COUNT(CASE WHEN status = 'pending' THEN 1 END)`,
      countRejected: sql<number>`COUNT(CASE WHEN status = 'rejected' THEN 1 END)`,
    })
    .from(contributions)
    .where(whereClause);

  const [expenseStats] = await db
    .select({
      totalExpenses: sql<number>`COALESCE(SUM(amount), 0)`,
    })
    .from(expenses);

  const totalVerified = Number(contribStats?.totalVerified ?? 0);
  const totalPending = Number(contribStats?.totalPending ?? 0);
  const totalExpenses = Number(expenseStats?.totalExpenses ?? 0);

  return {
    totalVerified,
    totalPending,
    totalExpenses,
    balance: totalVerified - totalExpenses,
    countVerified: Number(contribStats?.countVerified ?? 0),
    countPending: Number(contribStats?.countPending ?? 0),
    countRejected: Number(contribStats?.countRejected ?? 0),
  };
}
