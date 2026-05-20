import type { NormalizedMessage } from '@reunion/shared/types/platform';
import { getOutboundQueue } from '@reunion/shared/queue';

const COMMAND_PREFIX = '/';

export function isCommand(text?: string): boolean {
  return !!text && text.trim().startsWith(COMMAND_PREFIX);
}

interface Ctx {
  chatGroupId: string;
  userId: string;
  identityId: string;
}

export async function handleCommand(msg: NormalizedMessage, _ctx: Ctx): Promise<void> {
  const text = msg.content.text!.trim();
  const [raw] = text.split(/\s+/);
  const cmd = raw!.toLowerCase().replace(/^\//, '').split('@')[0];

  let reply = '';
  switch (cmd) {
    case 'help':
    case 'start':
      reply = HELP_TEXT;
      break;

    case 'event':
      // TODO(M3): implement
      reply = '📅 Chức năng event sẽ có ở milestone M3.';
      break;

    case 'rsvp':
      // TODO(M3): implement
      reply = '📋 Chức năng RSVP sẽ có ở milestone M3.';
      break;

    case 'who':
      // TODO(M3): implement
      reply = '👥 Chức năng danh sách sẽ có ở milestone M3.';
      break;

    case 'mytasks':
    case 'tasks':
      // TODO(M4): implement
      reply = '✅ Chức năng tasks sẽ có ở milestone M4.';
      break;

    case 'mydues':
      // TODO(M5): implement
      reply = '💰 Chức năng tài chính sẽ có ở milestone M5.';
      break;

    case 'link':
    case 'redeem':
      // TODO(M1): implement
      reply = '🔗 Chức năng liên kết tài khoản sẽ có ở milestone M1.';
      break;

    default:
      reply = `Không hiểu lệnh \`/${cmd}\`. Gõ /help để xem danh sách.`;
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
