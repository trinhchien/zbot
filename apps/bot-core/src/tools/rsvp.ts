import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { extractContext } from './index';
import {
  getPrimaryEvent,
  upsertRsvp,
  getParticipantsWithNames,
  getRsvpCounts,
} from '@reunion/db/repositories/events';

// ===== set_rsvp =====

const setRsvpSchema = z.object({
  status: z.enum(['yes', 'no', 'maybe']).describe('Trạng thái tham gia: yes=đi, no=không đi, maybe=chưa chắc'),
  plusOnes: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe('Số người đi kèm ngoài bản thân (0 = chỉ mình)'),
  notes: z.string().max(300).optional().describe('Ghi chú thêm (vd: "tớ đến muộn 30p", "đem xe hơi")'),
  userId: z
    .string()
    .uuid()
    .optional()
    .describe('UUID user cần ghi hộ (mặc định: người đang chat)'),
});

export const setRsvpTool = tool(
  async (input, config) => {
    const ctx = extractContext(config!);
    const targetUserId = input.userId ?? ctx.userId;

    const event = await getPrimaryEvent();
    if (!event) return JSON.stringify({ ok: false, error: 'Chưa có sự kiện nào' });

    await upsertRsvp(event.id, targetUserId, input.status, {
      plusOnes: input.plusOnes,
      notes: input.notes,
    });

    const statusLabels: Record<string, string> = {
      yes: 'Có đi ✅',
      no: 'Không đi ❌',
      maybe: 'Chưa chắc ❓',
    };

    return JSON.stringify({
      ok: true,
      status: input.status,
      message: `Đã ghi nhận: ${statusLabels[input.status]}.${input.plusOnes ? ` (+${input.plusOnes} người đi kèm)` : ''}`,
    });
  },
  {
    name: 'set_rsvp',
    description:
      'Đăng ký tham gia hoặc không tham gia sự kiện họp lớp. Dùng khi user nói "tớ đi", "tớ không đi", "chưa chắc", "tớ và vợ tớ cùng đi"... Có thể ghi hộ người khác nếu được yêu cầu.',
    schema: setRsvpSchema,
  },
);

// ===== list_rsvp =====

export const listRsvpTool = tool(
  async (_input, _config) => {
    const event = await getPrimaryEvent();
    if (!event) return JSON.stringify({ ok: false, error: 'Chưa có sự kiện nào' });

    const [participants, counts] = await Promise.all([
      getParticipantsWithNames(event.id),
      getRsvpCounts(event.id),
    ]);

    const groups: Record<string, string[]> = { yes: [], no: [], maybe: [], pending: [] };
    for (const p of participants) {
      const name = p.nickname ?? p.canonicalName;
      (groups[p.rsvpStatus] ?? groups['pending']!).push(name);
    }

    return JSON.stringify({
      ok: true,
      event: { id: event.id, name: event.name },
      summary: counts,
      groups,
    });
  },
  {
    name: 'list_rsvp',
    description:
      'Xem danh sách ai đã đăng ký tham gia sự kiện, phân nhóm theo trạng thái (đi / không đi / chưa chắc / chưa trả lời).',
    schema: z.object({}),
  },
);

export const rsvpTools = [setRsvpTool, listRsvpTool];
