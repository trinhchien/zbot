import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { extractContext, requireRole, requireVerified } from './index';
import {
  createCampaign,
  getCampaignById,
  getLatestOpenCampaign,
  recordContribution,
  verifyContribution,
  getContributions,
  recordExpense,
  getExpenses,
  financialSummary,
} from '@reunion/db/repositories/finance';
import { getPrimaryEvent } from '@reunion/db/repositories/events';

function formatVND(amount: number): string {
  return amount.toLocaleString('vi-VN') + '₫';
}

// ===== create_contribution_campaign =====

const createCampaignSchema = z.object({
  name: z.string().min(3).max(200).describe('Tên đợt thu (vd: "Quỹ họp lớp đợt 1")'),
  amountPerHead: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Số tiền mỗi người đóng (VND, số nguyên)'),
  deadline: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe('Hạn chót đóng tiền (ISO 8601)'),
  eventId: z.string().uuid().optional().describe('Gắn vào sự kiện (mặc định: sự kiện chính)'),
});

export const createContributionCampaignTool = tool(
  async (input, config) => {
    const ctx = extractContext(config!);
    await requireVerified(ctx.userId);
    await requireRole(ctx.userId, 'treasurer');

    let eventId = input.eventId;
    if (!eventId) {
      const event = await getPrimaryEvent();
      if (event) eventId = event.id;
    }

    const campaign = await createCampaign({
      name: input.name,
      eventId,
      amountPerHead: input.amountPerHead,
      deadline: input.deadline ? new Date(input.deadline) : undefined,
      createdByUserId: ctx.userId,
    });

    const perHead = campaign.amountPerHead ? ` (${formatVND(campaign.amountPerHead)}/người)` : '';
    return JSON.stringify({
      ok: true,
      campaignId: campaign.id,
      name: campaign.name,
      message: `Đã mở đợt thu "${campaign.name}"${perHead}.`,
    });
  },
  {
    name: 'create_contribution_campaign',
    description:
      'Mở đợt thu tiền (chỉ thủ quỹ). Dùng khi cần thu quỹ từ các thành viên cho sự kiện.',
    schema: createCampaignSchema,
  },
);

// ===== record_contribution =====

const recordContributionSchema = z.object({
  amount: z.number().int().positive().describe('Số tiền đã chuyển (VND, số nguyên)'),
  paymentProof: z
    .string()
    .max(500)
    .optional()
    .describe('Bằng chứng chuyển khoản (mã GD, URL ảnh, hoặc mô tả)'),
  paidAt: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe('Thời điểm chuyển khoản (mặc định: bây giờ)'),
  campaignId: z
    .string()
    .uuid()
    .optional()
    .describe('ID đợt thu (mặc định: đợt thu đang mở mới nhất)'),
  userId: z
    .string()
    .uuid()
    .optional()
    .describe('UUID người đóng tiền (mặc định: người đang chat)'),
});

export const recordContributionTool = tool(
  async (input, config) => {
    const ctx = extractContext(config!);
    await requireVerified(ctx.userId);
    const targetUserId = input.userId ?? ctx.userId;

    let campaignId = input.campaignId;
    if (!campaignId) {
      const campaign = await getLatestOpenCampaign();
      if (!campaign) return JSON.stringify({ ok: false, error: 'Hiện không có đợt thu nào đang mở' });
      campaignId = campaign.id;
    } else {
      const campaign = await getCampaignById(campaignId);
      if (!campaign) return JSON.stringify({ ok: false, error: 'Không tìm thấy đợt thu' });
      if (campaign.status !== 'open') return JSON.stringify({ ok: false, error: 'Đợt thu này đã đóng' });
    }

    const row = await recordContribution({
      campaignId,
      userId: targetUserId,
      amount: input.amount,
      paymentProof: input.paymentProof,
      paidAt: input.paidAt ? new Date(input.paidAt) : undefined,
    });

    return JSON.stringify({
      ok: true,
      contributionId: row.id,
      amount: input.amount,
      message: `Đã ghi nhận đóng góp ${formatVND(input.amount)} — chờ thủ quỹ xác nhận.`,
    });
  },
  {
    name: 'record_contribution',
    description:
      'Ghi nhận đóng góp tiền của thành viên (status=pending, chờ thủ quỹ xác nhận). Dùng khi user nói "tớ đã chuyển X đồng", "tớ đóng tiền rồi".',
    schema: recordContributionSchema,
  },
);

// ===== verify_contribution =====

const verifyContributionSchema = z.object({
  contributionId: z.string().uuid().describe('ID đóng góp cần xác nhận/từ chối'),
  approved: z.boolean().describe('true = xác nhận đã nhận tiền, false = từ chối (không hợp lệ)'),
  note: z.string().max(300).optional().describe('Ghi chú (lý do từ chối, hoặc ghi chú thêm)'),
});

export const verifyContributionTool = tool(
  async (input, config) => {
    const ctx = extractContext(config!);
    await requireVerified(ctx.userId);
    await requireRole(ctx.userId, 'treasurer');

    const result = await verifyContribution({
      contributionId: input.contributionId,
      approved: input.approved,
      note: input.note,
      actorUserId: ctx.userId,
      platform: ctx.platform,
      messageId: ctx.messageId,
    });

    if (!result.ok) return JSON.stringify(result);

    return JSON.stringify({
      ok: true,
      status: result.status,
      message: input.approved
        ? `✅ Đã xác nhận đóng góp. Audit log đã ghi.`
        : `❌ Đã từ chối đóng góp. Audit log đã ghi.`,
    });
  },
  {
    name: 'verify_contribution',
    description:
      'Xác nhận hoặc từ chối đóng góp tiền (CHỈ thủ quỹ). Bot KHÔNG tự xác nhận — phải có thủ quỹ ra lệnh. Mọi thao tác đều được ghi vào audit log.',
    schema: verifyContributionSchema,
  },
);

// ===== list_contribution_status =====

const listContributionStatusSchema = z.object({
  campaignId: z
    .string()
    .uuid()
    .optional()
    .describe('ID đợt thu (mặc định: đợt thu đang mở mới nhất)'),
});

export const listContributionStatusTool = tool(
  async (input, config) => {
    const ctx = extractContext(config!);
    await requireVerified(ctx.userId);
    let campaignId = input.campaignId;
    let campaignName = '';
    let amountPerHead: number | null = null;

    if (campaignId) {
      const campaign = await getCampaignById(campaignId);
      if (!campaign) return JSON.stringify({ ok: false, error: 'Không tìm thấy đợt thu' });
      campaignName = campaign.name;
      amountPerHead = campaign.amountPerHead ?? null;
    } else {
      const campaign = await getLatestOpenCampaign();
      if (!campaign) return JSON.stringify({ ok: false, error: 'Hiện không có đợt thu nào' });
      campaignId = campaign.id;
      campaignName = campaign.name;
      amountPerHead = campaign.amountPerHead ?? null;
    }

    const rows = await getContributions(campaignId);

    const grouped = {
      verified: rows.filter((r) => r.status === 'verified'),
      pending: rows.filter((r) => r.status === 'pending'),
      rejected: rows.filter((r) => r.status === 'rejected'),
    };

    const totalVerified = grouped.verified.reduce((s, r) => s + r.amount, 0);

    return JSON.stringify({
      ok: true,
      campaign: {
        id: campaignId,
        name: campaignName,
        amountPerHead,
        amountPerHeadFormatted: amountPerHead ? formatVND(amountPerHead) : null,
      },
      summary: {
        totalVerified,
        totalVerifiedFormatted: formatVND(totalVerified),
        countVerified: grouped.verified.length,
        countPending: grouped.pending.length,
        countRejected: grouped.rejected.length,
      },
      verified: grouped.verified.map((r) => ({
        name: r.userNickname ?? r.userName,
        amount: r.amount,
        amountFormatted: formatVND(r.amount),
      })),
      pending: grouped.pending.map((r) => ({
        id: r.id,
        name: r.userNickname ?? r.userName,
        amount: r.amount,
        amountFormatted: formatVND(r.amount),
        proof: r.paymentProof ?? null,
      })),
    });
  },
  {
    name: 'list_contribution_status',
    description:
      'Xem ai đã đóng tiền, ai chưa, bao nhiêu tiền đã xác nhận trong đợt thu. Dùng khi hỏi về tình hình thu quỹ.',
    schema: listContributionStatusSchema,
  },
);

// ===== record_expense =====

const recordExpenseSchema = z.object({
  description: z.string().min(3).max(300).describe('Mô tả khoản chi (vd: "Thuê nhà hàng", "In banner")'),
  amount: z.number().int().positive().describe('Số tiền (VND, số nguyên)'),
  category: z
    .string()
    .max(100)
    .optional()
    .describe('Loại chi phí (vd: "venue", "food", "decoration", "transport")'),
  receipt: z
    .string()
    .max(500)
    .optional()
    .describe('URL ảnh hóa đơn hoặc mô tả bằng chứng'),
  spentAt: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe('Thời điểm chi (mặc định: bây giờ)'),
  paidByUserId: z
    .string()
    .uuid()
    .optional()
    .describe('UUID người đã ứng tiền (mặc định: người đang chat)'),
  eventId: z.string().uuid().optional().describe('ID sự kiện (mặc định: sự kiện chính)'),
});

export const recordExpenseTool = tool(
  async (input, config) => {
    const ctx = extractContext(config!);
    await requireVerified(ctx.userId);
    await requireRole(ctx.userId, 'organizer');

    let eventId = input.eventId;
    if (!eventId) {
      const event = await getPrimaryEvent();
      if (event) eventId = event.id;
    }

    const expense = await recordExpense({
      eventId,
      description: input.description,
      amount: input.amount,
      paidByUserId: input.paidByUserId ?? ctx.userId,
      receipt: input.receipt,
      category: input.category,
      spentAt: input.spentAt ? new Date(input.spentAt) : undefined,
    });

    return JSON.stringify({
      ok: true,
      expenseId: expense.id,
      amount: input.amount,
      message: `Đã ghi khoản chi "${input.description}" — ${formatVND(input.amount)}.`,
    });
  },
  {
    name: 'record_expense',
    description:
      'Ghi nhận khoản chi tiêu cho sự kiện (chỉ ban tổ chức). Dùng khi có chi phí thực tế như thuê địa điểm, đặt đồ ăn, in ấn.',
    schema: recordExpenseSchema,
  },
);

// ===== financial_summary =====

export const financialSummaryTool = tool(
  async (_input, config) => {
    const ctx = extractContext(config!);
    await requireVerified(ctx.userId);
    const event = await getPrimaryEvent();
    const campaign = await getLatestOpenCampaign(event?.id);

    const [summary, expenseList] = await Promise.all([
      financialSummary(campaign?.id),
      getExpenses(event?.id),
    ]);

    const totalExpensesByCategory: Record<string, number> = {};
    for (const e of expenseList) {
      const cat = e.category ?? 'khác';
      totalExpensesByCategory[cat] = (totalExpensesByCategory[cat] ?? 0) + e.amount;
    }

    return JSON.stringify({
      ok: true,
      event: event ? { id: event.id, name: event.name } : null,
      campaign: campaign ? { id: campaign.id, name: campaign.name } : null,
      contributions: {
        totalVerified: summary.totalVerified,
        totalVerifiedFormatted: formatVND(summary.totalVerified),
        totalPending: summary.totalPending,
        totalPendingFormatted: formatVND(summary.totalPending),
        countVerified: summary.countVerified,
        countPending: summary.countPending,
        countRejected: summary.countRejected,
      },
      expenses: {
        total: summary.totalExpenses,
        totalFormatted: formatVND(summary.totalExpenses),
        count: expenseList.length,
        byCategory: Object.entries(totalExpensesByCategory).map(([cat, amt]) => ({
          category: cat,
          amount: amt,
          amountFormatted: formatVND(amt),
        })),
      },
      balance: {
        amount: summary.balance,
        amountFormatted: formatVND(summary.balance),
        status: summary.balance >= 0 ? 'surplus' : 'deficit',
      },
    });
  },
  {
    name: 'financial_summary',
    description:
      'Xem tổng quan thu chi: tổng tiền đã thu (xác nhận), tổng chi tiêu, số dư, phân loại chi phí. Dùng khi hỏi về tình hình tài chính.',
    schema: z.object({}),
  },
);

export const financeTools = [
  createContributionCampaignTool,
  recordContributionTool,
  verifyContributionTool,
  listContributionStatusTool,
  recordExpenseTool,
  financialSummaryTool,
];
