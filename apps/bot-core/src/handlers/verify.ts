import type { NormalizedMessage } from '@reunion/shared/types/platform';
import { getOutboundQueue } from '@reunion/shared/queue';
import { logger } from '@reunion/shared/logger';
import { db } from '@reunion/db/client';
import { users, userIdentities } from '@reunion/db/schema';
import { eq, and, ne } from 'drizzle-orm';

/** Chuẩn hoá SĐT: chỉ giữ chữ số và dấu + đầu */
function normalizePhone(raw: string): string {
  const stripped = raw.replace(/\s+/g, '');
  return stripped.startsWith('+') ? stripped : `+${stripped}`;
}

interface VerifyCtx {
  identityId: string;
  userId: string;
}

export async function handlePhoneContact(msg: NormalizedMessage, ctx: VerifyCtx): Promise<void> {
  const contact = msg.content.contact!;
  const phone = normalizePhone(contact.phone);

  const reply = async (text: string) => {
    const outboundQueue = getOutboundQueue();
    await outboundQueue.add('outbound', {
      message: { platform: msg.platform, chatId: msg.chatId, text },
    });
  };

  // Kiểm tra identity hiện tại đã verified chưa
  const [currentIdentity] = await db
    .select({ phoneVerifiedAt: userIdentities.phoneVerifiedAt })
    .from(userIdentities)
    .where(eq(userIdentities.id, ctx.identityId));

  if (currentIdentity?.phoneVerifiedAt) {
    await reply('✅ Tài khoản của bạn đã được xác thực rồi. Không cần làm lại.');
    return;
  }

  // Kiểm tra SĐT này đã thuộc user nào chưa
  const [existingUser] = await db
    .select({ id: users.id, canonicalName: users.canonicalName })
    .from(users)
    .where(and(eq(users.phone, phone), ne(users.id, ctx.userId)));

  if (existingUser) {
    // Merge: chuyển identity hiện tại sang user đã có phone này
    const previousUserId = ctx.userId;

    await db
      .update(userIdentities)
      .set({ userId: existingUser.id, phoneVerifiedAt: new Date() })
      .where(eq(userIdentities.id, ctx.identityId));

    // Xóa orphan user nếu không còn identity nào trỏ vào
    const remaining = await db
      .select({ id: userIdentities.id })
      .from(userIdentities)
      .where(eq(userIdentities.userId, previousUserId))
      .limit(1);

    if (remaining.length === 0) {
      await db.delete(users).where(eq(users.id, previousUserId));
      logger.info({ orphanUserId: previousUserId }, 'Deleted orphan user after phone merge');
    }

    logger.info({ phone, targetUserId: existingUser.id }, 'Phone verification: merged identity');
    await reply(
      `✅ Xác thực thành công!\n\nSố điện thoại ${phone} đã khớp với tài khoản **${existingUser.canonicalName}**. Các thông tin RSVP, task, đóng góp đã được hợp nhất.`,
    );
  } else {
    // SĐT mới: gán cho user hiện tại
    await db
      .update(users)
      .set({ phone, phoneVerifiedAt: new Date() })
      .where(eq(users.id, ctx.userId));

    await db
      .update(userIdentities)
      .set({ phoneVerifiedAt: new Date() })
      .where(eq(userIdentities.id, ctx.identityId));

    logger.info({ phone, userId: ctx.userId }, 'Phone verification: new phone linked');
    await reply(
      `✅ Xác thực thành công!\n\nSố điện thoại ${phone} đã được liên kết với tài khoản của bạn. Bạn có thể quay lại nhóm và dùng đầy đủ tính năng.`,
    );
  }
}
