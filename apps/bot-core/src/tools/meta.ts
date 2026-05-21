import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { extractContext, requireVerified } from './index';
import { db } from '@reunion/db/client';
import { messages } from '@reunion/db/schema';
import { users, userIdentities } from '@reunion/db/schema';
import { eq, desc, and } from 'drizzle-orm';

// ===== summarize_conversation =====

export const summarizeConversationTool = tool(
  async (input, config) => {
    const ctx = extractContext(config!);
    await requireVerified(ctx.userId);

    // Fetch recent messages with sender display names
    const rows = await db
      .select({
        content: messages.content,
        createdAt: messages.createdAt,
        displayName: userIdentities.platformDisplayName,
        senderNickname: users.nickname,
        senderName: users.canonicalName,
      })
      .from(messages)
      .leftJoin(userIdentities, eq(messages.senderIdentityId, userIdentities.id))
      .leftJoin(users, eq(userIdentities.userId, users.id))
      .where(
        and(
          eq(messages.chatGroupId, ctx.chatGroupId),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(input.limit ?? 50);

    rows.reverse(); // chronological order

    return JSON.stringify({
      ok: true,
      count: rows.length,
      messages: rows.map((r) => ({
        sender: r.senderNickname ?? r.senderName ?? r.displayName ?? 'Unknown',
        content: r.content ?? '',
        at: r.createdAt.toISOString(),
      })),
      instruction:
        'Dùng danh sách messages trên để viết tóm tắt ngắn gọn (~5-10 bullet points) về những gì đã được thảo luận.',
    });
  },
  {
    name: 'summarize_conversation',
    description:
      'Lấy lịch sử chat gần đây để tóm tắt nội dung đã thảo luận. Dùng khi user yêu cầu "tóm tắt hôm nay nói gì", "recap lại đi". Bot sẽ đọc messages và tự viết tóm tắt.',
    schema: z.object({
      limit: z
        .number()
        .int()
        .min(10)
        .max(100)
        .default(50)
        .describe('Số tin nhắn gần nhất cần lấy (mặc định 50)'),
    }),
  },
);

export const metaTools = [summarizeConversationTool];
