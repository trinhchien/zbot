import { Bot, GrammyError, HttpError } from 'grammy';
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
      allowed_updates: ['message', 'edited_message', 'callback_query'],
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
