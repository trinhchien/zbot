import { format, formatDistanceToNow } from 'date-fns';
import { toZonedTime, formatInTimeZone } from 'date-fns-tz';
import { vi } from 'date-fns/locale';

const TZ = 'Asia/Ho_Chi_Minh';

export function formatVN(date: Date | string, fmt = 'dd/MM/yyyy HH:mm'): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return format(toZonedTime(d, TZ), fmt);
}

export function formatEventDateVN(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return formatInTimeZone(d, TZ, "EEEE 'ngày' dd/MM/yyyy 'lúc' HH:mm", { locale: vi });
}

export function relativeVN(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return formatDistanceToNow(d, { addSuffix: true, locale: vi });
}

export function nowVN(): Date {
  return toZonedTime(new Date(), TZ);
}
