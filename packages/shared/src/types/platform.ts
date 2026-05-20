export type Platform = 'telegram' | 'zalo' | 'messenger';

export interface NormalizedMessage {
  platform: Platform;
  platformMessageId: string;
  chatId: string;
  chatType: 'group' | 'private';
  chatName?: string;
  sender: {
    platformUserId: string;
    displayName: string;
    username?: string;
  };
  content: {
    text?: string;
    attachments?: Attachment[];
    replyToMessageId?: string;
    replyToText?: string;
    mentions: string[];
    mentionsByName: string[];
    botMentioned: boolean;
  };
  timestamp: Date;
  isFromBot: boolean;
  raw: unknown;
}

export interface Attachment {
  type: 'image' | 'file' | 'audio' | 'video' | 'sticker';
  url?: string;
  mimeType?: string;
  fileName?: string;
  size?: number;
}

export interface OutboundMessage {
  platform: Platform;
  chatId: string;
  text: string;
  replyToPlatformMessageId?: string;
  parseMode?: 'markdown' | 'html' | 'plain';
  silent?: boolean;
}

export interface PlatformAdapter {
  readonly platform: Platform;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<{ platformMessageId: string }>;
  supports?(feature: 'reactions' | 'images' | 'stickers'): boolean;
}
