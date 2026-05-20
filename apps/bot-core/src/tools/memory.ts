import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { extractContext } from './index';

// Stub implementations for M0 — full implementations in M2

const FACT_CATEGORIES = ['personal', 'preference', 'dietary', 'contact', 'role', 'commitment', 'other'] as const;

// 1. remember_user_fact
const rememberSchema = z.object({
  userId: z.string().uuid().optional().describe('UUID of target user. Omit for current speaker.'),
  fact: z.string().min(3).max(500).describe('The fact in concise sentence form.'),
  category: z.enum(FACT_CATEGORIES).describe('Category of the fact'),
  confidence: z.number().min(0).max(1).default(0.9).optional(),
});

export const rememberUserFactTool = tool(
  async (input, config) => {
    const ctx = extractContext(config!);
    // TODO(M2): implement with embedding + DB insert
    return JSON.stringify({ ok: true, factId: 'stub', userId: input.userId ?? ctx.userId });
  },
  {
    name: 'remember_user_fact',
    description:
      'Lưu một fact về user vào trí nhớ dài hạn. Dùng khi user kể về bản thân (dị ứng, nghề nghiệp, kỷ niệm) hoặc khi cần ghi nhớ cam kết.',
    schema: rememberSchema,
  },
);

// 2. recall_user_info
const recallSchema = z.object({
  userId: z.string().uuid().optional(),
  query: z.string().optional().describe('Optional semantic search query.'),
  category: z.enum(FACT_CATEGORIES).optional(),
  limit: z.number().int().min(1).max(20).default(5),
});

export const recallUserInfoTool = tool(
  async (_input, _config) => {
    // TODO(M2): implement with vector search
    return JSON.stringify({ facts: [] });
  },
  {
    name: 'recall_user_info',
    description: 'Truy xuất facts đã lưu về user.',
    schema: recallSchema,
  },
);

// 3. search_past_messages
const searchSchema = z.object({
  query: z.string().min(3),
  limit: z.number().int().min(1).max(15).default(8),
});

export const searchPastMessagesTool = tool(
  async (_input, _config) => {
    // TODO(M2): implement with vector search on messages
    return JSON.stringify({ results: [] });
  },
  {
    name: 'search_past_messages',
    description: 'Semantic search trong lịch sử chat của group.',
    schema: searchSchema,
  },
);

export const memoryTools = [rememberUserFactTool, recallUserInfoTool, searchPastMessagesTool];
