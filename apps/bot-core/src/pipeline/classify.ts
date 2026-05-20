import type { NormalizedMessage } from '@reunion/shared/types/platform';

export type Tier = 'store_only' | 'rule_based' | 'flash_lite' | 'flash';

const SIMPLE_QUERY_PATTERNS = [
  /ai\s+(đã\s+)?đóng\s+tiền/i,
  /ai\s+đi/i,
  /list\s+(task|tasks|công\s*việc)/i,
  /(còn\s+)?bao\s+(nhiêu|lâu)/i,
];

const COMPLEX_INDICATORS = [/tóm\s*tắt/i, /\?.*\?/, /^.{200,}$/s, /và|hoặc|nhưng/i];

export function classify(msg: NormalizedMessage): Tier {
  const text = msg.content.text ?? '';

  // No interaction with bot → just store
  if (!msg.content.botMentioned && text.length > 0) {
    return 'store_only';
  }

  // No text content
  if (!text.trim()) return 'store_only';

  // Complex indicators → primary model
  if (COMPLEX_INDICATORS.some((r) => r.test(text))) return 'flash';

  // Simple queries → lite model
  if (SIMPLE_QUERY_PATTERNS.some((r) => r.test(text))) return 'flash_lite';

  // Default for bot-mentioned: use primary
  return 'flash';
}
