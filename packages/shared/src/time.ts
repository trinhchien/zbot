import { format, formatDistanceToNow } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { vi } from 'date-fns/locale';

const TZ = 'Asia/Ho_Chi_Minh';

export function formatVN(date: Date | string, fmt = 'dd/MM/yyyy HH:mm'): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return format(toZonedTime(d, TZ), fmt);
}

export function relativeVN(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return formatDistanceToNow(d, { addSuffix: true, locale: vi });
}

export function nowVN(): Date {
  return toZonedTime(new Date(), TZ);
}
