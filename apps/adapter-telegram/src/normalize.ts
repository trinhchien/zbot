import type { Context } from 'grammy';
import type { NormalizedMessage } from '@reunion/shared/types/platform';

export function normalizeTelegramMessage(ctx: Context, botUsername: string): NormalizedMessage {
  const msg = ctx.message!;
  const text = msg.text ?? msg.caption ?? '';
  const mentions: string[] = [];
  const mentionsByName: string[] = [];

  (msg.entities ?? []).forEach((e) => {
    if (e.type === 'mention') {
      const at = text.slice(e.offset, e.offset + e.length);
      mentionsByName.push(at.replace(/^@/, ''));
    } else if (e.type === 'text_mention' && e.user) {
      mentions.push(String(e.user.id));
    }
  });

  const botMentioned =
    mentionsByName.some((n) => n.toLowerCase() === botUsername.toLowerCase()) ||
    mentions.includes(String(ctx.me.id)) ||
    msg.reply_to_message?.from?.id === ctx.me.id;

  return {
    platform: 'telegram',
    platformMessageId: String(msg.message_id),
    chatId: String(msg.chat.id),
    chatType: msg.chat.type === 'private' ? 'private' : 'group',
    chatName: 'title' in msg.chat ? msg.chat.title : undefined,
    sender: {
      platformUserId: String(msg.from!.id),
      displayName:
        [msg.from!.first_name, msg.from!.last_name].filter(Boolean).join(' ').trim() ||
        msg.from!.username ||
        'Unknown',
      username: msg.from!.username,
    },
    content: {
      text,
      attachments: [],
      replyToMessageId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
      replyToText: msg.reply_to_message?.text ?? msg.reply_to_message?.caption,
      mentions,
      mentionsByName,
      botMentioned,
    },
    timestamp: new Date(msg.date * 1000),
    isFromBot: msg.from?.is_bot ?? false,
    raw: msg,
  };
}
