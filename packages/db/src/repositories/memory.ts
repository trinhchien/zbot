import { db } from '../client';
import { userFacts, messages } from '../schema';
import { eq, and, isNotNull, sql } from 'drizzle-orm';

type FactCategory = 'personal' | 'preference' | 'dietary' | 'contact' | 'role' | 'commitment' | 'other';

// ===== User Facts =====

export async function insertUserFact(opts: {
  userId: string;
  fact: string;
  category: FactCategory;
  confidence: number;
  embedding: number[];
  sourceMessageId?: string;
}): Promise<string> {
  const [row] = await db
    .insert(userFacts)
    .values({
      userId: opts.userId,
      fact: opts.fact,
      category: opts.category,
      confidence: opts.confidence,
      embedding: opts.embedding,
      sourceMessageId: opts.sourceMessageId ?? null,
    })
    .returning({ id: userFacts.id });

  return row!.id;
}

export async function searchUserFacts(opts: {
  userId: string;
  embedding: number[];
  limit: number;
  category?: FactCategory;
}): Promise<Array<{ id: string; fact: string; category: string; confidence: number }>> {
  const embeddingLiteral = `[${opts.embedding.join(',')}]`;

  const rows = await db
    .select({
      id: userFacts.id,
      fact: userFacts.fact,
      category: userFacts.category,
      confidence: userFacts.confidence,
    })
    .from(userFacts)
    .where(
      and(
        eq(userFacts.userId, opts.userId),
        opts.category ? eq(userFacts.category, opts.category) : undefined,
        isNotNull(userFacts.embedding),
      ),
    )
    .orderBy(sql`embedding <=> ${embeddingLiteral}::vector`)
    .limit(opts.limit);

  return rows;
}

export async function getUserFactsByCategory(opts: {
  userId: string;
  category?: FactCategory;
  limit: number;
}): Promise<Array<{ id: string; fact: string; category: string; confidence: number }>> {
  return db
    .select({
      id: userFacts.id,
      fact: userFacts.fact,
      category: userFacts.category,
      confidence: userFacts.confidence,
    })
    .from(userFacts)
    .where(
      and(
        eq(userFacts.userId, opts.userId),
        opts.category ? eq(userFacts.category, opts.category) : undefined,
      ),
    )
    .orderBy(userFacts.createdAt)
    .limit(opts.limit);
}

// ===== Message embeddings =====

export async function updateMessageEmbedding(messageId: string, embedding: number[]): Promise<void> {
  await db
    .update(messages)
    .set({ embedding, embeddingStatus: 'done' })
    .where(eq(messages.id, messageId));
}

export async function markMessageEmbeddingFailed(messageId: string): Promise<void> {
  await db
    .update(messages)
    .set({ embeddingStatus: 'failed' })
    .where(eq(messages.id, messageId));
}

export async function searchMessages(opts: {
  chatGroupId: string;
  embedding: number[];
  limit: number;
}): Promise<Array<{ id: string; content: string | null; createdAt: Date }>> {
  const embeddingLiteral = `[${opts.embedding.join(',')}]`;

  return db
    .select({
      id: messages.id,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.chatGroupId, opts.chatGroupId),
        isNotNull(messages.embedding),
      ),
    )
    .orderBy(sql`embedding <=> ${embeddingLiteral}::vector`)
    .limit(opts.limit);
}
