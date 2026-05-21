import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { extractContext, requireRole, requireVerified } from './index';
import {
  getPrimaryEvent,
  createEvent,
  updateEvent,
  insertEventDecision,
  getEventDecisions,
  getRsvpCounts,
} from '@reunion/db/repositories/events';

const EVENT_STATUS_MAP: Record<string, string> = {
  planning: 'Đang lên kế hoạch',
  confirmed: 'Đã xác nhận',
  done: 'Đã hoàn thành',
  cancelled: 'Đã hủy',
};

// ===== create_event =====

const createEventSchema = z.object({
  name: z.string().min(3).max(200).describe('Tên sự kiện'),
  description: z.string().max(1000).optional().describe('Mô tả ngắn về sự kiện'),
  eventDate: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe('Ngày giờ sự kiện (ISO 8601, vd: 2025-09-02T11:00:00+07:00)'),
  location: z.string().max(300).optional().describe('Địa điểm tổ chức'),
});

export const createEventTool = tool(
  async (input, config) => {
    const ctx = extractContext(config!);
    await requireVerified(ctx.userId);
    await requireRole(ctx.userId, 'organizer');

    const event = await createEvent({
      name: input.name,
      description: input.description,
      eventDate: input.eventDate ? new Date(input.eventDate) : undefined,
      location: input.location,
      createdByUserId: ctx.userId,
    });

    return JSON.stringify({
      ok: true,
      eventId: event.id,
      name: event.name,
      message: `Đã tạo sự kiện "${event.name}" thành công.`,
    });
  },
  {
    name: 'create_event',
    description:
      'Tạo sự kiện mới (chỉ ban tổ chức). Dùng khi cần tạo thêm một sự kiện hoặc phụ-sự-kiện ngoài sự kiện họp lớp chính.',
    schema: createEventSchema,
  },
);

// ===== update_event_decision =====

const updateDecisionSchema = z.object({
  topic: z
    .string()
    .min(2)
    .max(200)
    .describe('Chủ đề quyết định (vd: "địa điểm", "ngày tổ chức", "menu", "quà tặng")'),
  decision: z.string().min(3).max(1000).describe('Nội dung quyết định đã chốt'),
  eventId: z.string().uuid().optional().describe('ID sự kiện (mặc định: sự kiện chính)'),
});

export const updateEventDecisionTool = tool(
  async (input, config) => {
    const ctx = extractContext(config!);
    await requireVerified(ctx.userId);

    let eventId = input.eventId;
    if (!eventId) {
      const event = await getPrimaryEvent();
      if (!event) return JSON.stringify({ ok: false, error: 'Chưa có sự kiện nào' });
      eventId = event.id;
    }

    const decision = await insertEventDecision({
      eventId,
      topic: input.topic,
      decision: input.decision,
      decidedByUserId: ctx.userId,
      sourceMessageId: ctx.messageId,
    });

    return JSON.stringify({
      ok: true,
      decisionId: decision.id,
      message: `Đã ghi nhận quyết định về "${input.topic}": ${input.decision}`,
    });
  },
  {
    name: 'update_event_decision',
    description:
      'Ghi lại một quyết định đã được chốt cho sự kiện (vd: chốt địa điểm, ngày giờ, menu). Bất kỳ thành viên nào cũng có thể dùng tool này.',
    schema: updateDecisionSchema,
  },
);

// ===== list_event_status =====

export const listEventStatusTool = tool(
  async (_input, config) => {
    const ctx = extractContext(config!);
    await requireVerified(ctx.userId);
    const event = await getPrimaryEvent();
    if (!event) return JSON.stringify({ ok: false, error: 'Chưa có sự kiện nào' });

    const [counts, decisions] = await Promise.all([
      getRsvpCounts(event.id),
      getEventDecisions(event.id),
    ]);

    return JSON.stringify({
      ok: true,
      event: {
        id: event.id,
        name: event.name,
        date: event.eventDate?.toISOString() ?? null,
        location: event.location ?? null,
        status: event.status,
        statusLabel: EVENT_STATUS_MAP[event.status] ?? event.status,
        budgetTotal: event.budgetTotal,
      },
      rsvp: counts,
      decisions: decisions.map((d) => ({
        topic: d.topic,
        decision: d.decision,
        at: d.decidedAt.toISOString(),
      })),
    });
  },
  {
    name: 'list_event_status',
    description:
      'Xem thông tin đầy đủ về sự kiện chính: ngày giờ, địa điểm, trạng thái, số lượng RSVP, và các quyết định đã được chốt.',
    schema: z.object({}),
  },
);

// ===== set_event_status =====

const setEventStatusSchema = z.object({
  status: z
    .enum(['planning', 'confirmed', 'done', 'cancelled'])
    .describe('Trạng thái mới của sự kiện'),
  eventDate: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe('Cập nhật ngày giờ cùng lúc (ISO 8601)'),
  location: z.string().max(300).optional().describe('Cập nhật địa điểm cùng lúc'),
  eventId: z.string().uuid().optional().describe('ID sự kiện (mặc định: sự kiện chính)'),
});

export const setEventStatusTool = tool(
  async (input, config) => {
    const ctx = extractContext(config!);
    await requireVerified(ctx.userId);
    await requireRole(ctx.userId, 'organizer');

    let eventId = input.eventId;
    if (!eventId) {
      const event = await getPrimaryEvent();
      if (!event) return JSON.stringify({ ok: false, error: 'Chưa có sự kiện nào' });
      eventId = event.id;
    }

    const patch: {
      status: 'planning' | 'confirmed' | 'done' | 'cancelled';
      eventDate?: Date;
      location?: string;
    } = { status: input.status };
    if (input.eventDate !== undefined) patch.eventDate = new Date(input.eventDate);
    if (input.location !== undefined) patch.location = input.location;

    const updated = await updateEvent(eventId, patch);
    if (!updated) return JSON.stringify({ ok: false, error: 'Không tìm thấy sự kiện' });

    return JSON.stringify({
      ok: true,
      status: updated.status,
      message: `Đã cập nhật trạng thái sự kiện thành "${EVENT_STATUS_MAP[updated.status] ?? updated.status}".`,
    });
  },
  {
    name: 'set_event_status',
    description:
      'Thay đổi trạng thái sự kiện (chỉ ban tổ chức). Ví dụ: chuyển "planning" → "confirmed" khi đã chốt ngày giờ + địa điểm.',
    schema: setEventStatusSchema,
  },
);

export const eventTools = [
  createEventTool,
  updateEventDecisionTool,
  listEventStatusTool,
  setEventStatusTool,
];
