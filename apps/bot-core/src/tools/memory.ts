import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { extractContext, requireVerified } from './index';
import { embed } from '../services/embedding';
import {
  insertUserFact,
  searchUserFacts,
  getUserFactsByCategory,
  searchMessages,
} from '@reunion/db/repositories/memory';

const FACT_CATEGORIES = ['personal', 'preference', 'dietary', 'contact', 'role', 'commitment', 'other'] as const;
type FactCategory = (typeof FACT_CATEGORIES)[number];

// ===== remember_user_fact =====

const rememberSchema = z.object({
  userId: z.string().uuid().optional().describe('UUID of target user. Omit for current speaker.'),
  fact: z.string().min(3).max(500).describe('The fact in concise sentence form.'),
  category: z.enum(FACT_CATEGORIES).describe('Category of the fact'),
  confidence: z.number().min(0).max(1).default(0.9).optional(),
});

export const rememberUserFactTool = tool(
  async (input, config) => {
    const ctx = extractContext(config!);
    await requireVerified(ctx.userId);
    const targetUserId = input.userId ?? ctx.userId;

    const [embedding] = await embed([input.fact]);
    if (!embedding || embedding.length === 0) {
      return JSON.stringify({ ok: false, error: 'Embedding failed' });
    }

    const factId = await insertUserFact({
      userId: targetUserId,
      fact: input.fact,
      category: input.category as FactCategory,
      confidence: input.confidence ?? 0.9,
      embedding,
      sourceMessageId: ctx.messageId,
    });

    return JSON.stringify({ ok: true, factId, userId: targetUserId });
  },
  {
    name: 'remember_user_fact',
    description:
      'Lưu một fact về user vào trí nhớ dài hạn. Dùng khi user kể về bản thân (dị ứng, nghề nghiệp, kỷ niệm) hoặc khi cần ghi nhớ cam kết.',
    schema: rememberSchema,
  },
);

// ===== recall_user_info =====

const recallSchema = z.object({
  userId: z.string().uuid().optional(),
  query: z.string().optional().describe('Semantic search query để tìm facts liên quan.'),
  category: z.enum(FACT_CATEGORIES).optional(),
  limit: z.number().int().min(1).max(20).default(5),
});

export const recallUserInfoTool = tool(
  async (input, config) => {
    const ctx = extractContext(config!);
    await requireVerified(ctx.userId);
    const targetUserId = input.userId ?? ctx.userId;

    let facts: Array<{ id: string; fact: string; category: string; confidence: number }>;

    if (input.query) {
      const [embedding] = await embed([input.query]);
      if (!embedding || embedding.length === 0) {
        facts = [];
      } else {
        facts = await searchUserFacts({
          userId: targetUserId,
          embedding,
          limit: input.limit,
          category: input.category as FactCategory | undefined,
        });
      }
    } else {
      // No query — fetch by category (most recent first)
      facts = await getUserFactsByCategory({
        userId: targetUserId,
        category: input.category as FactCategory | undefined,
        limit: input.limit,
      });
    }

    return JSON.stringify({
      facts: facts.map((f) => ({ fact: f.fact, category: f.category, confidence: f.confidence })),
    });
  },
  {
    name: 'recall_user_info',
    description:
      'Truy xuất facts đã lưu về user. Dùng query để tìm kiếm ngữ nghĩa, hoặc dùng category để lọc theo loại.',
    schema: recallSchema,
  },
);

// ===== search_past_messages =====

const searchSchema = z.object({
  query: z.string().min(3).describe('Nội dung cần tìm trong lịch sử chat.'),
  limit: z.number().int().min(1).max(15).default(8),
});

export const searchPastMessagesTool = tool(
  async (input, config) => {
    const ctx = extractContext(config!);
    await requireVerified(ctx.userId);

    const [embedding] = await embed([input.query]);
    if (!embedding || embedding.length === 0) {
      return JSON.stringify({ results: [] });
    }

    const results = await searchMessages({
      chatGroupId: ctx.chatGroupId,
      embedding,
      limit: input.limit,
    });

    return JSON.stringify({
      results: results.map((r) => ({
        content: r.content,
        timestamp: r.createdAt.toISOString(),
      })),
    });
  },
  {
    name: 'search_past_messages',
    description:
      'Tìm kiếm ngữ nghĩa trong lịch sử chat của group. Dùng khi cần tìm thông tin đã nhắc đến trước đó.',
    schema: searchSchema,
  },
);

export const memoryTools = [rememberUserFactTool, recallUserInfoTool, searchPastMessagesTool];
