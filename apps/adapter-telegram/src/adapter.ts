import { Bot, GrammyError, HttpError, Keyboard } from 'grammy';
import { env } from '@reunion/shared/config/env';
import { logger } from '@reunion/shared/logger';
import { getInboundQueue, getRedisConnection } from '@reunion/shared/queue';
import { Worker } from 'bullmq';
import { normalizeTelegramMessage } from './normalize';
import type { OutboundMessage, PlatformAdapter } from '@reunion/shared/types/platform';

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = 'telegram' as const;
  private bot: Bot;
  private outboundWorker?: Worker;

  constructor() {
    if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN required');
    this.bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  }

  async start(): Promise<void> {
    const me = await this.bot.api.getMe();
    logger.info({ botUsername: me.username, botId: me.id }, 'Telegram bot resolved');

    const allowedChats = env.TELEGRAM_ALLOWED_CHAT_IDS.split(',').filter(Boolean);
    const inboundQueue = getInboundQueue();

    // Handler A: private /start — send phone-share button
    this.bot.chatType('private').command('start', async (ctx) => {
      const keyboard = new Keyboard()
        .requestContact('📱 Chia sẻ số điện thoại')
        .resized()
        .oneTime();
      await ctx.reply(
        'Chào bạn! 👋\n\nĐể tham gia đầy đủ các tính năng của bot, vui lòng xác thực số điện thoại bằng cách nhấn nút bên dưới.\n\n🔒 Số điện thoại chỉ dùng để xác minh danh tính, không chia sẻ với ai khác.',
        { reply_markup: keyboard },
      );
    });

    // Handler B: contact message — phone verification
    this.bot.on('message:contact', async (ctx) => {
      const contact = ctx.message.contact;
      if (contact.user_id && contact.user_id !== ctx.from!.id) {
        await ctx.reply('⚠️ Vui lòng chia sẻ số điện thoại của chính bạn, không phải số của người khác.');
        return;
      }
      const normalized = {
        platform: 'telegram' as const,
        platformMessageId: String(ctx.message.message_id),
        chatId: String(ctx.chat.id),
        chatType: 'private' as const,
        sender: {
          platformUserId: String(ctx.from!.id),
          displayName:
            [ctx.from!.first_name, ctx.from!.last_name].filter(Boolean).join(' ').trim() ||
            ctx.from!.username ||
            'Unknown',
          username: ctx.from!.username,
        },
        content: {
          text: '',
          attachments: [],
          mentions: [],
          mentionsByName: [],
          botMentioned: false,
          contact: {
            phone: contact.phone_number,
            firstName: contact.first_name,
            lastName: contact.last_name,
          },
        },
        timestamp: new Date(ctx.message.date * 1000),
        isFromBot: false,
        raw: ctx.message,
      };
      await inboundQueue.add('inbound', { message: normalized }, {
        jobId: `tg:contact:${ctx.from!.id}:${ctx.message.message_id}`,
        removeOnComplete: 100,
        removeOnFail: 500,
      });
    });

    this.bot.on('message', async (ctx) => {
      try {
        if (allowedChats.length > 0 && !allowedChats.includes(String(ctx.chat.id))) {
          logger.debug({ chatId: ctx.chat.id }, 'Telegram message from non-allowlisted chat — ignored');
          return;
        }
        const normalized = normalizeTelegramMessage(ctx, me.username!);
        await inboundQueue.add(
          'inbound',
          { message: normalized },
          {
            jobId: `tg:${ctx.message.message_id}:${ctx.chat.id}`,
            removeOnComplete: 1000,
            removeOnFail: 5000,
          },
        );
      } catch (e) {
        logger.error({ err: e }, 'Error processing inbound TG message');
      }
    });

    this.bot.catch((err) => {
      logger.error({ err: err.error, updateId: err.ctx.update.update_id }, 'Telegram bot error');
      if (err.error instanceof GrammyError) logger.error('Telegram API error');
      else if (err.error instanceof HttpError) logger.error('HTTP error');
    });

    // Outbound worker
    this.outboundWorker = new Worker<{ message: OutboundMessage }>(
      'outbound-messages',
      async (job) => {
        if (job.data.message.platform !== 'telegram') return;
        await this.send(job.data.message);
      },
      { ...getRedisConnection(), concurrency: 5 },
    );

    // Long polling start
    await this.bot.start({
      drop_pending_updates: false,
      onStart: () => logger.info('Telegram polling started'),
      allowed_updates: ['message', 'edited_message', 'callback_query'] as const,
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    await this.outboundWorker?.close();
  }

  async send(msg: OutboundMessage): Promise<{ platformMessageId: string }> {
    const sent = await this.bot.api.sendMessage(msg.chatId, msg.text, {
      reply_parameters: msg.replyToPlatformMessageId
        ? { message_id: Number(msg.replyToPlatformMessageId) }
        : undefined,
      parse_mode:
        msg.parseMode === 'markdown' ? 'MarkdownV2' : msg.parseMode === 'html' ? 'HTML' : undefined,
      disable_notification: msg.silent,
    });
    return { platformMessageId: String(sent.message_id) };
  }
}
