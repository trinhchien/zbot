import type { NormalizedMessage } from '@reunion/shared/types/platform';
import { getOutboundQueue } from '@reunion/shared/queue';
import { formatEventDateVN } from '@reunion/shared/time';
import { logger } from '@reunion/shared/logger';
import { db } from '@reunion/db/client';
import { users, userIdentities, linkCodes } from '@reunion/db/schema';
import {
  getPrimaryEvent,
  getRsvpCounts,
  upsertRsvp,
  getParticipantsWithNames,
} from '@reunion/db/repositories/events';
import { listTasks } from '@reunion/db/repositories/tasks';
import { getUserContributions, getLatestOpenCampaign } from '@reunion/db/repositories/finance';
import { eq } from 'drizzle-orm';
import { customAlphabet } from 'nanoid';

const COMMAND_PREFIX = '/';

// Unambiguous alphabet for link codes (no 0/O/I/L)
const generateCode = customAlphabet('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 6);

export function isCommand(text?: string): boolean {
  return !!text && text.trim().startsWith(COMMAND_PREFIX);
}

interface Ctx {
  chatGroupId: string;
  userId: string;
  identityId: string;
}

export async function handleCommand(msg: NormalizedMessage, ctx: Ctx): Promise<void> {
  const text = msg.content.text!.trim();
  const parts = text.split(/\s+/);
  const raw = parts[0]!;
  const cmd = raw.toLowerCase().replace(/^\//, '').split('@')[0];
  const args = parts.slice(1);

  let reply = '';
  try {
    switch (cmd) {
      case 'help':
      case 'start':
        reply = HELP_TEXT;
        break;

      case 'event':
        reply = await handleEvent();
        break;

      case 'rsvp':
        reply = await handleRsvp(ctx.userId, args);
        break;

      case 'who':
        reply = await handleWho();
        break;

      case 'mytasks':
        reply = await handleMyTasks(ctx.userId);
        break;

      case 'tasks':
        reply = await handleAllTasks();
        break;

      case 'mydues':
        reply = await handleMyDues(ctx.userId);
        break;

      case 'link':
        reply = await handleLink(ctx.userId);
        break;

      case 'redeem':
        reply = await handleRedeem(ctx.userId, ctx.identityId, args);
        break;

      default:
        reply = `Không hiểu lệnh \`/${cmd}\`. Gõ /help để xem danh sách.`;
    }
  } catch (err) {
    logger.error({ err, cmd }, 'Command handler error');
    reply = '⚠️ Có lỗi xảy ra khi xử lý lệnh. Vui lòng thử lại sau.';
  }

  const outboundQueue = getOutboundQueue();
  await outboundQueue.add('outbound', {
    message: {
      platform: msg.platform,
      chatId: msg.chatId,
      text: reply,
      replyToPlatformMessageId: msg.platformMessageId,
    },
  });
}

// ===== /event =====
async function handleEvent(): Promise<string> {
  const event = await getPrimaryEvent();
  if (!event) {
    return '📅 Chưa có sự kiện nào được tạo.';
  }

  const counts = await getRsvpCounts(event.id);
  const yesCount = counts.yes ?? 0;
  const totalCount = (counts.yes ?? 0) + (counts.no ?? 0) + (counts.maybe ?? 0);

  const dateStr = event.eventDate ? formatEventDateVN(event.eventDate) : 'Chưa chốt ngày';
  const location = event.location ?? 'Chưa chốt địa điểm';
  const statusMap: Record<string, string> = {
    planning: '🔵 Đang lên kế hoạch',
    confirmed: '🟢 Đã xác nhận',
    done: '✅ Đã hoàn thành',
    cancelled: '🔴 Đã hủy',
  };

  return [
    `📅 ${event.name}`,
    `🗓 ${dateStr}`,
    `📍 ${location}`,
    `📊 Trạng thái: ${statusMap[event.status] ?? event.status}`,
    '',
    `🙋 Đã có ${yesCount}/${totalCount} bạn xác nhận tham gia`,
    `  → Xem chi tiết: /who`,
  ].join('\n');
}

// ===== /rsvp =====
async function handleRsvp(userId: string, args: string[]): Promise<string> {
  const event = await getPrimaryEvent();
  if (!event) {
    return '📅 Chưa có sự kiện nào để đăng ký.';
  }

  const statusArg = (args[0] ?? '').toLowerCase();
  const validStatuses = ['yes', 'no', 'maybe'] as const;
  if (!validStatuses.includes(statusArg as any)) {
    return '❓ Cú pháp: /rsvp yes|no|maybe\n\nVí dụ: /rsvp yes';
  }

  const status = statusArg as 'yes' | 'no' | 'maybe';
  await upsertRsvp(event.id, userId, status);

  const statusLabels: Record<string, string> = {
    yes: '✅ Đi',
    no: '❌ Không đi',
    maybe: '❓ Chưa chắc',
  };

  return `✅ Đã ghi nhận: ${statusLabels[status]}. Bạn có thể đổi bất kỳ lúc nào.`;
}

// ===== /who =====
async function handleWho(): Promise<string> {
  const event = await getPrimaryEvent();
  if (!event) {
    return '📅 Chưa có sự kiện nào.';
  }

  const participants = await getParticipantsWithNames(event.id);

  const groups: Record<string, string[]> = {
    yes: [],
    no: [],
    maybe: [],
    pending: [],
  };

  for (const p of participants) {
    const name = p.nickname ?? p.canonicalName;
    const bucket = groups[p.rsvpStatus] ?? groups.pending!;
    bucket.push(name);
  }

  const lines: string[] = [`🙋 Danh sách ${event.name}:`, ''];

  const sections: { key: string; emoji: string; label: string }[] = [
    { key: 'yes', emoji: '✅', label: 'Đi' },
    { key: 'no', emoji: '❌', label: 'Không đi' },
    { key: 'maybe', emoji: '❓', label: 'Chưa chắc' },
    { key: 'pending', emoji: '⏳', label: 'Chưa trả lời' },
  ];

  for (const section of sections) {
    const names = groups[section.key]!;
    lines.push(`${section.emoji} ${section.label} (${names.length}):`);
    if (names.length === 0) {
      lines.push('  (chưa có ai)');
    } else {
      for (const name of names) {
        lines.push(`  • ${name}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

// ===== /mytasks =====
async function handleMyTasks(userId: string): Promise<string> {
  const tasks = await listTasks({ assigneeUserId: userId, limit: 20 });
  const active = tasks.filter((t) => t.status !== 'cancelled' && t.status !== 'done');

  if (active.length === 0) {
    return '📋 Bạn không có công việc nào đang chờ.';
  }

  const STATUS_EMOJI: Record<string, string> = {
    todo: '⏳',
    doing: '🔄',
    blocked: '🚫',
  };

  const lines = [`📋 Công việc của bạn (${active.length}):`];
  for (const t of active) {
    const emoji = STATUS_EMOJI[t.status] ?? '•';
    const due = t.dueDate ? ` — hạn ${formatEventDateVN(t.dueDate)}` : '';
    lines.push(`${emoji} ${t.title}${due}`);
  }
  lines.push('\n→ Chat với bot để cập nhật trạng thái bất kỳ lúc nào.');
  return lines.join('\n');
}

// ===== /tasks =====
async function handleAllTasks(): Promise<string> {
  const tasks = await listTasks({ limit: 30 });
  const active = tasks.filter((t) => t.status !== 'cancelled');

  if (active.length === 0) {
    return '📋 Chưa có task nào. Dùng bot để tạo task mới.';
  }

  const STATUS_EMOJI: Record<string, string> = {
    todo: '⏳',
    doing: '🔄',
    done: '✅',
    blocked: '🚫',
  };

  const lines = [`📋 Tất cả task (${active.length}):`];
  for (const t of active) {
    const emoji = STATUS_EMOJI[t.status] ?? '•';
    const assignee = t.assigneeNickname ?? t.assigneeName ?? 'chưa giao';
    lines.push(`${emoji} ${t.title} — ${assignee}`);
  }
  return lines.join('\n');
}

// ===== /mydues =====
async function handleMyDues(userId: string): Promise<string> {
  const campaign = await getLatestOpenCampaign();
  const rows = await getUserContributions(userId, campaign?.id);

  if (rows.length === 0) {
    const hint = campaign
      ? `Đợt thu "${campaign.name}" đang mở. Chat với bot để ghi nhận nếu bạn đã chuyển khoản.`
      : 'Hiện chưa có đợt thu nào đang mở.';
    return `💰 Bạn chưa có đóng góp nào.\n${hint}`;
  }

  const STATUS_EMOJI: Record<string, string> = {
    verified: '✅',
    pending: '⏳',
    rejected: '❌',
  };

  const lines = ['💰 Đóng góp của bạn:'];
  for (const r of rows) {
    const emoji = STATUS_EMOJI[r.status] ?? '•';
    const amount = r.amount.toLocaleString('vi-VN') + '₫';
    const label =
      r.status === 'verified' ? 'đã xác nhận' : r.status === 'pending' ? 'chờ xác nhận' : 'từ chối';
    lines.push(`${emoji} ${r.campaignName}: ${amount} — ${label}`);
  }
  return lines.join('\n');
}

// ===== /link =====
async function handleLink(userId: string): Promise<string> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await db.insert(linkCodes).values({
    code,
    userId,
    expiresAt,
  });

  return [
    `🔗 Mã liên kết của bạn: \`${code}\``,
    `Dùng \`/redeem ${code}\` trên platform khác (Zalo) trong 10 phút để hợp nhất tài khoản.`,
  ].join('\n');
}

// ===== /redeem =====
async function handleRedeem(currentUserId: string, currentIdentityId: string, args: string[]): Promise<string> {
  const codeStr = (args[0] ?? '').toUpperCase().trim();
  if (!codeStr) {
    return '❓ Cú pháp: /redeem <MÃ>\n\nVí dụ: /redeem ABC123';
  }

  // Look up the code
  const [linkCode] = await db
    .select()
    .from(linkCodes)
    .where(eq(linkCodes.code, codeStr));

  if (!linkCode) {
    return '❌ Mã không tồn tại. Kiểm tra lại hoặc tạo mã mới bằng /link.';
  }

  if (linkCode.consumedAt) {
    return '❌ Mã này đã được sử dụng rồi. Tạo mã mới bằng /link.';
  }

  if (linkCode.expiresAt < new Date()) {
    return '❌ Mã đã hết hạn. Tạo mã mới bằng /link.';
  }

  const targetUserId = linkCode.userId;

  // If trying to link to themselves
  if (targetUserId === currentUserId) {
    // Mark consumed anyway
    await db
      .update(linkCodes)
      .set({ consumedAt: new Date() })
      .where(eq(linkCodes.code, codeStr));
    return '✅ Tài khoản của bạn đã được xác nhận. Mã đã sử dụng.';
  }

  // Move current identity to target user
  const previousUserId = currentUserId;

  await db
    .update(userIdentities)
    .set({ userId: targetUserId, linkedAt: new Date() })
    .where(eq(userIdentities.id, currentIdentityId));

  // Clean up orphan user if no other identities point to it
  const remainingIdentities = await db
    .select()
    .from(userIdentities)
    .where(eq(userIdentities.userId, previousUserId))
    .limit(1);

  if (remainingIdentities.length === 0) {
    await db.delete(users).where(eq(users.id, previousUserId));
    logger.info({ orphanUserId: previousUserId }, 'Deleted orphan user after identity merge');
  }

  // Mark code consumed
  await db
    .update(linkCodes)
    .set({ consumedAt: new Date() })
    .where(eq(linkCodes.code, codeStr));

  return '✅ Đã liên kết với tài khoản của bạn trên Telegram. Mọi thông tin sẽ được hợp nhất.';
}

const HELP_TEXT = `Mình là trợ lý lớp 🤖

📅 Sự kiện
  /event       — xem trạng thái họp lớp
  /rsvp yes|no|maybe — đăng ký tham gia
  /who         — ai đã đăng ký

✅ Công việc
  /mytasks     — công việc của bạn
  /tasks       — toàn bộ công việc

💰 Quỹ
  /mydues      — bạn đã đóng góp gì

🔗 Khác
  /link        — tạo mã liên kết Zalo ↔ Telegram
  /redeem <CODE> — nhập mã liên kết

Mention @bot hoặc reply tin của mình để chat tự nhiên.`;
