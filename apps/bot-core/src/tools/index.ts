import type { StructuredToolInterface } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { db } from '@reunion/db/client';
import { users } from '@reunion/db/schema';
import { eq } from 'drizzle-orm';

/**
 * ToolContext is passed via RunnableConfig.configurable from the graph.
 */
export interface ToolContext {
  userId: string;
  identityId: string;
  chatGroupId: string;
  messageId: string;
  platform: 'telegram' | 'zalo' | 'messenger';
}

export function extractContext(config: RunnableConfig): ToolContext {
  const c = config.configurable ?? {};
  return {
    userId: c['ctxUserId'] as string,
    identityId: c['ctxIdentityId'] as string,
    chatGroupId: c['ctxChatGroupId'] as string,
    messageId: c['ctxMessageId'] as string,
    platform: c['ctxPlatform'] as 'telegram' | 'zalo' | 'messenger',
  };
}

// === Permission helper ===
export type Role = 'member' | 'organizer' | 'treasurer' | 'admin';

const ROLE_ORDER: Record<Role, number> = { member: 0, organizer: 1, treasurer: 1, admin: 2 };

export async function requireRole(userId: string, required: Role): Promise<void> {
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  if (!u || ROLE_ORDER[u.role as Role] < ROLE_ORDER[required]) {
    throw new Error(`Bạn cần quyền "${required}" để thực hiện việc này (đang là "${u?.role ?? 'không xác định'}")`);
  }
}

// === Tool registry ===
// Stub tools for M0 — real implementations come in M2+
import { memoryTools } from './memory';

export const allTools: StructuredToolInterface[] = [...memoryTools];

export const toolsByName: Record<string, StructuredToolInterface> = Object.fromEntries(
  allTools.map((t) => [t.name, t]),
);
