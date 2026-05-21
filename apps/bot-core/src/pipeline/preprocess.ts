import type { NormalizedMessage } from '@reunion/shared/types/platform';
import { db } from '@reunion/db/client';
import { users, userIdentities, chatGroups, messages } from '@reunion/db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '@reunion/shared/logger';
import { getJobsQueue } from '@reunion/shared/queue';
import { classify } from './classify';
import { handleCommand, isCommand } from '../handlers/commands';
import { handlePhoneContact } from '../handlers/verify';
import { orchestrate } from './graph';

export async function processInbound(msg: NormalizedMessage): Promise<void> {
  if (msg.isFromBot) return;

  // 1. Upsert chat group
  const [group] = await db
    .insert(chatGroups)
    .values({
      platform: msg.platform,
      platformChatId: msg.chatId,
      name: msg.chatName,
    })
    .onConflictDoUpdate({
      target: [chatGroups.platform, chatGroups.platformChatId],
      set: { name: msg.chatName ?? undefined },
    })
    .returning();

  if (!group) {
    logger.error({ chatId: msg.chatId }, 'Failed to upsert chat group');
    return;
  }

  // 2. Upsert sender identity
  const [identity] = await db
    .insert(userIdentities)
    .values({
      platform: msg.platform,
      platformUserId: msg.sender.platformUserId,
      platformDisplayName: msg.sender.displayName,
      platformUsername: msg.sender.username,
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [userIdentities.platform, userIdentities.platformUserId],
      set: { lastSeenAt: new Date(), platformDisplayName: msg.sender.displayName },
    })
    .returning();

  if (!identity) {
    logger.error({ sender: msg.sender.platformUserId }, 'Failed to upsert identity');
    return;
  }

  // 3. Auto-create canonical user if not linked yet
  if (!identity.userId) {
    const [user] = await db.insert(users).values({ canonicalName: msg.sender.displayName }).returning();
    if (user) {
      await db
        .update(userIdentities)
        .set({ userId: user.id, linkedAt: new Date() })
        .where(eq(userIdentities.id, identity.id));
      identity.userId = user.id;
      logger.info({ userId: user.id, name: user.canonicalName }, 'Auto-created canonical user');
    }
  }

  // 4. Persist message (with idempotency)
  const [persisted] = await db
    .insert(messages)
    .values({
      chatGroupId: group.id,
      platform: msg.platform,
      platformMessageId: msg.platformMessageId,
      senderIdentityId: identity.id,
      content: msg.content.text,
      attachments: msg.content.attachments ?? [],
      mentions: msg.content.mentions,
      botMentioned: msg.content.botMentioned,
    })
    .onConflictDoNothing({ target: [messages.platform, messages.platformMessageId] })
    .returning();

  if (!persisted) {
    logger.debug({ msgId: msg.platformMessageId }, 'Duplicate message — skipped');
    return;
  }

  // 5. Enqueue background embedding for this message
  const jobsQueue = getJobsQueue();
  await jobsQueue.add(
    'embed-batch',
    { type: 'embed-batch', payload: { messageId: persisted.id } },
    { jobId: `embed:${persisted.id}`, removeOnComplete: 500, removeOnFail: 1000 },
  );

  // 5b. Contact message → phone verification flow
  if (msg.content.contact) {
    await handlePhoneContact(msg, { identityId: identity.id, userId: identity.userId! });
    return;
  }

  // 6. Slash commands take priority
  if (isCommand(msg.content.text)) {
    await handleCommand(msg, { chatGroupId: group.id, userId: identity.userId!, identityId: identity.id });
    return;
  }

  // 7. Classify and dispatch
  const tier = classify(msg);
  logger.debug({ tier, msgId: persisted.id }, 'Classified message');

  if (tier === 'store_only') return;

  // M2: Invoke LangGraph orchestration
  logger.info({ tier, msgId: persisted.id }, 'Invoking LangGraph orchestration');
  await orchestrate({
    message: msg,
    persistedMessageId: persisted.id,
    chatGroupId: group.id,
    userId: identity.userId!,
    identityId: identity.id,
    tier,
  });
}
