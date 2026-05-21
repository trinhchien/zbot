import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { extractContext, requireVerified } from './index';
import {
  createTask,
  assignTask,
  updateTaskStatus,
  listTasks,
  getTaskById,
} from '@reunion/db/repositories/tasks';
import { getPrimaryEvent } from '@reunion/db/repositories/events';

const TASK_STATUS_LABELS: Record<string, string> = {
  todo: 'Chưa làm',
  doing: 'Đang làm',
  done: 'Xong',
  blocked: 'Bị chặn',
  cancelled: 'Đã hủy',
};

const TASK_PRIORITY_LABELS: Record<string, string> = {
  high: '🔴 Cao',
  normal: '🟡 Bình thường',
  low: '🟢 Thấp',
};

// ===== create_task =====

const createTaskSchema = z.object({
  title: z.string().min(3).max(300).describe('Tên công việc (ngắn gọn, rõ ràng)'),
  description: z.string().max(1000).optional().describe('Mô tả chi tiết nếu cần'),
  assigneeUserId: z
    .string()
    .uuid()
    .optional()
    .describe('UUID người được giao (để trống = chưa giao cho ai)'),
  dueDate: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe('Hạn chót (ISO 8601, vd: 2025-08-15T23:59:00+07:00)'),
  priority: z
    .enum(['low', 'normal', 'high'])
    .default('normal')
    .describe('Độ ưu tiên: low=thấp, normal=bình thường, high=cao'),
  eventId: z.string().uuid().optional().describe('Gắn vào sự kiện (mặc định: sự kiện chính)'),
});

export const createTaskTool = tool(
  async (input, config) => {
    const ctx = extractContext(config!);
    await requireVerified(ctx.userId);

    let eventId = input.eventId;
    if (!eventId) {
      const event = await getPrimaryEvent();
      if (event) eventId = event.id;
    }

    const task = await createTask({
      title: input.title,
      description: input.description,
      eventId,
      assigneeUserId: input.assigneeUserId,
      dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
      priority: input.priority as 'low' | 'normal' | 'high',
      createdByUserId: ctx.userId,
    });

    return JSON.stringify({
      ok: true,
      taskId: task.id,
      title: task.title,
      message: `Đã tạo task "${task.title}" (${TASK_PRIORITY_LABELS[task.priority] ?? task.priority}).${task.assigneeUserId ? '' : ' Chưa giao cho ai.'}`,
    });
  },
  {
    name: 'create_task',
    description:
      'Tạo task/công việc mới cho sự kiện. Dùng khi user đề xuất việc cần làm (vd: "ai đó làm banner", "cần đặt xe"). Nếu biết người làm thì giao luôn qua assigneeUserId.',
    schema: createTaskSchema,
  },
);

// ===== assign_task =====

const assignTaskSchema = z.object({
  taskId: z.string().uuid().describe('ID của task cần giao'),
  assigneeUserId: z
    .string()
    .uuid()
    .optional()
    .describe('UUID người nhận việc (để trống = giao cho người đang chat)'),
});

export const assignTaskTool = tool(
  async (input, config) => {
    const ctx = extractContext(config!);
    await requireVerified(ctx.userId);
    const assigneeUserId = input.assigneeUserId ?? ctx.userId;

    const task = await getTaskById(input.taskId);
    if (!task) return JSON.stringify({ ok: false, error: 'Không tìm thấy task này' });

    const updated = await assignTask(input.taskId, assigneeUserId);
    if (!updated) return JSON.stringify({ ok: false, error: 'Không tìm thấy task này' });

    return JSON.stringify({
      ok: true,
      taskId: updated.id,
      assigneeUserId,
      message: `Đã giao task "${task.title}" thành công.`,
    });
  },
  {
    name: 'assign_task',
    description:
      'Giao task cho một thành viên. Dùng khi user nói "tớ nhận việc này", "giao việc X cho Y". Nếu không chỉ định người thì mặc định giao cho người đang chat.',
    schema: assignTaskSchema,
  },
);

// ===== update_task_status =====

const updateTaskStatusSchema = z.object({
  taskId: z.string().uuid().describe('ID của task cần cập nhật'),
  status: z
    .enum(['todo', 'doing', 'done', 'blocked', 'cancelled'])
    .describe('Trạng thái mới: todo=chưa làm, doing=đang làm, done=xong, blocked=bị chặn, cancelled=hủy'),
});

export const updateTaskStatusTool = tool(
  async (input, config) => {
    const ctx = extractContext(config!);
    await requireVerified(ctx.userId);
    const task = await getTaskById(input.taskId);
    if (!task) return JSON.stringify({ ok: false, error: 'Không tìm thấy task này' });

    const updated = await updateTaskStatus(input.taskId, input.status);
    if (!updated) return JSON.stringify({ ok: false, error: 'Không tìm thấy task này' });

    return JSON.stringify({
      ok: true,
      taskId: updated.id,
      status: updated.status,
      message: `Task "${task.title}" → ${TASK_STATUS_LABELS[updated.status] ?? updated.status}.`,
    });
  },
  {
    name: 'update_task_status',
    description:
      'Cập nhật trạng thái task. Dùng khi user báo "tớ đã xong", "đang làm rồi", "bị chặn vì...".',
    schema: updateTaskStatusSchema,
  },
);

// ===== list_tasks =====

const listTasksSchema = z.object({
  scope: z
    .enum(['mine', 'all', 'unassigned'])
    .default('all')
    .describe('mine=task của tôi, all=tất cả, unassigned=chưa có người nhận'),
  status: z
    .enum(['todo', 'doing', 'done', 'blocked', 'cancelled'])
    .optional()
    .describe('Lọc theo trạng thái (để trống = tất cả trạng thái trừ cancelled)'),
  limit: z.number().int().min(1).max(30).default(15),
});

export const listTasksTool = tool(
  async (input, config) => {
    const ctx = extractContext(config!);
    await requireVerified(ctx.userId);

    const rows = await listTasks({
      assigneeUserId: input.scope === 'mine' ? ctx.userId : undefined,
      unassignedOnly: input.scope === 'unassigned' ? true : undefined,
      status: input.status as 'todo' | 'doing' | 'done' | 'blocked' | 'cancelled' | undefined,
      limit: input.limit,
    });

    // Default: exclude cancelled tasks unless explicitly requested
    const filtered =
      input.status
        ? rows
        : rows.filter((r) => r.status !== 'cancelled');

    return JSON.stringify({
      ok: true,
      total: filtered.length,
      tasks: filtered.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        statusLabel: TASK_STATUS_LABELS[t.status] ?? t.status,
        priority: t.priority,
        assignee: t.assigneeNickname ?? t.assigneeName ?? null,
        dueDate: t.dueDate?.toISOString() ?? null,
      })),
    });
  },
  {
    name: 'list_tasks',
    description:
      'Xem danh sách task. Dùng mine để xem task của mình, all để xem tất cả, unassigned để tìm task chưa có người nhận.',
    schema: listTasksSchema,
  },
);

export const taskTools = [createTaskTool, assignTaskTool, updateTaskStatusTool, listTasksTool];
